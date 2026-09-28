import { EventEmitter } from 'node:events';
import {
  AppError,
  HUB_API_VERSION,
  HubAuthResult,
  HubEvent,
  type HubMeta,
  type HubRequest,
  type HubStatus,
  type HubUser,
  type PresenceMember,
} from '@comitiva/contract';
import type { SecretStore } from '../secrets/SecretStore';
import { HubClient } from './HubClient';
import { PusherSocket } from './PusherSocket';

/** What survives a restart besides the token (which is in the SecretStore). */
export interface HubSettings {
  url: string | null;
  user: HubUser | null;
}

export interface HubServiceDeps {
  settings: { get(): HubSettings; set(settings: HubSettings): void };
  secrets: SecretStore;
  /** Names this device's token on the hub (shown to the user there). */
  deviceName: string;
  fetch?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  log?: (message: string) => void;
}

export interface HubServiceEvents {
  status: [HubStatus];
  event: [channel: string, event: HubEvent];
  presence: [channel: string, members: PresenceMember[]];
}

export const HUB_TOKEN_REF = 'hub:token';

/**
 * The hub this desktop talks to (ADR 0017). It keeps the device token in the
 * SecretStore and holds the REST client and the WebSocket, so no credential
 * reaches the renderer: the renderer's RemoteBackend calls through `request`
 * and listens through `subscribe` (over IPC).
 */
export class HubService extends EventEmitter<HubServiceEvents> {
  private url: string | null = null;
  private user: HubUser | null = null;
  private token: string | null = null;
  private meta: HubMeta | null = null;
  private socket: PusherSocket | null = null;
  private readonly subscriptions = new Map<string, number>();
  /** The last members seen on each presence channel, for a listener that comes later. */
  private readonly presence = new Map<string, PresenceMember[]>();

  constructor(private readonly deps: HubServiceDeps) {
    super();
  }

  /** At boot: the stored hub and session. The hub is checked in the background. */
  async init(): Promise<void> {
    const stored = this.deps.settings.get();
    this.url = stored.url;
    this.user = stored.user;
    try {
      this.token = this.url ? await this.deps.secrets.get(HUB_TOKEN_REF) : null;
    } catch {
      this.token = null;
    }
    if (!this.token) this.user = null;
    this.changed();
    if (this.url) void this.refresh();
  }

  status(): HubStatus {
    return {
      url: this.url,
      meta: this.meta,
      user: this.token ? this.user : null,
      realtime: this.socket?.state ?? 'off',
    };
  }

  signedInUser(): HubUser | null {
    return this.token ? this.user : null;
  }

  /**
   * Sets the hub after checking it answers like one this app supports; null
   * forgets it. A different hub signs out.
   */
  async configure(url: string | null): Promise<HubStatus> {
    if (url === null) {
      await this.logout();
      this.url = null;
      this.meta = null;
      this.save();
      this.changed();
      return this.status();
    }
    const base = url.replace(/\/+$/, '');
    const meta = await this.probe(base);
    if (base !== this.url) await this.forgetSession();
    this.url = base;
    this.meta = meta;
    this.save();
    this.changed();
    return this.status();
  }

  async register(input: {
    name: string;
    email: string;
    password: string;
    invitationToken?: string | undefined;
  }): Promise<HubStatus> {
    const result = await this.client(false).request('POST', '/api/v1/auth/register', {
      body: {
        ...input,
        ...(input.invitationToken === undefined ? {} : { invitationToken: input.invitationToken }),
        deviceName: this.deps.deviceName,
      },
    });
    return this.signedIn(HubAuthResult.parse(result));
  }

  async login(input: { email: string; password: string }): Promise<HubStatus> {
    const result = await this.client(false).request('POST', '/api/v1/auth/login', {
      body: { ...input, deviceName: this.deps.deviceName },
    });
    return this.signedIn(HubAuthResult.parse(result));
  }

  /** Revokes this device's token at the hub (best effort) and forgets it. */
  async logout(): Promise<HubStatus> {
    if (this.token && this.url) {
      await this.client()
        .request('POST', '/api/v1/auth/logout')
        .catch(() => undefined);
    }
    await this.forgetSession();
    this.changed();
    return this.status();
  }

  /** A REST call with the device token. A rejected token signs out. */
  async request(req: HubRequest): Promise<unknown> {
    return this.call(() =>
      this.client().request(req.method, req.path, { query: req.query, body: req.body }),
    );
  }

  /** The REST client with the token, for main's own callers (runs, attachments). */
  client(withToken = true): HubClient {
    if (!this.url) throw new AppError('hub_unreachable', 'No hub is set up');
    if (withToken && !this.token) throw new AppError('hub_auth_required', 'Sign in to the hub');
    return new HubClient({
      baseUrl: this.url,
      token: withToken ? this.token : null,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
  }

  /** Runs a hub call; a rejected token signs out so the UI asks to sign in. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && err.code === 'hub_auth_required' && this.token) {
        await this.forgetSession();
        this.changed();
      }
      throw err;
    }
  }

  /** Starts listening to a channel; counted, so several listeners can share one. */
  subscribe(channel: string): void {
    const count = this.subscriptions.get(channel) ?? 0;
    this.subscriptions.set(channel, count + 1);
    if (count === 0) this.socket?.subscribe(channel);
  }

  unsubscribe(channel: string): void {
    const count = this.subscriptions.get(channel) ?? 0;
    if (count <= 1) {
      this.subscriptions.delete(channel);
      this.presence.delete(channel);
      this.socket?.unsubscribe(channel);
    } else {
      this.subscriptions.set(channel, count - 1);
    }
  }

  /** Who was online on a presence channel, as last reported. */
  presenceOf(channel: string): PresenceMember[] | undefined {
    return this.presence.get(channel);
  }

  /** Before quitting. */
  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  // ------------------------------------------------------------------ internals

  private async probe(base: string): Promise<HubMeta> {
    const meta = await new HubClient({
      baseUrl: base,
      token: null,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    }).meta();
    if (meta.apiVersion !== HUB_API_VERSION) {
      throw new AppError(
        'hub_incompatible',
        `The hub speaks API version ${meta.apiVersion}; this app speaks ${HUB_API_VERSION}`,
      );
    }
    return meta;
  }

  /** Checks the hub and the session after a restart, then connects the socket. */
  private async refresh(): Promise<void> {
    try {
      this.meta = await this.probe(this.url!);
      if (this.token) {
        const me = await this.call(() => this.client().request('GET', '/api/v1/me'));
        this.user = me as HubUser;
        this.save();
        this.connectRealtime();
      }
    } catch (err) {
      this.log(`the hub did not answer at start: ${AppError.from(err).message}`);
      // Still try the socket: it reconnects on its own when the hub comes back.
      if (this.token && this.meta) this.connectRealtime();
    }
    this.changed();
  }

  private async signedIn(result: HubAuthResult): Promise<HubStatus> {
    await this.deps.secrets.set(HUB_TOKEN_REF, result.token);
    this.token = result.token;
    this.user = result.user;
    this.save();
    if (!this.meta && this.url) this.meta = await this.probe(this.url).catch(() => null);
    this.connectRealtime();
    this.changed();
    return this.status();
  }

  private async forgetSession(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    this.token = null;
    this.user = null;
    await this.deps.secrets.delete(HUB_TOKEN_REF).catch(() => undefined);
    this.save();
  }

  private connectRealtime(): void {
    const realtime = this.meta?.realtime;
    if (!realtime || !this.token) return;
    this.socket?.close();
    const socket = new PusherSocket({
      ...realtime,
      authorize: (socketId, channel) =>
        this.call(() => this.client().authorizeChannel(socketId, channel)),
      ...(this.deps.WebSocketImpl ? { WebSocketImpl: this.deps.WebSocketImpl } : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    socket.on('state', () => this.changed());
    socket.on('presence', (channel, members) => {
      this.presence.set(channel, members);
      this.emit('presence', channel, members);
    });
    socket.on('event', (channel, name, data) => {
      const parsed = HubEvent.safeParse(data);
      if (!parsed.success || parsed.data.type !== name) {
        this.log(`ignored an event the contract does not describe: ${name} on ${channel}`);
        return;
      }
      this.emit('event', channel, parsed.data);
    });
    this.socket = socket;
    for (const channel of this.subscriptions.keys()) socket.subscribe(channel);
    socket.connect();
  }

  private save(): void {
    this.deps.settings.set({ url: this.url, user: this.token ? this.user : null });
  }

  private changed(): void {
    this.emit('status', this.status());
  }

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.warn(`HubService: ${m}`)))(message);
  }
}
