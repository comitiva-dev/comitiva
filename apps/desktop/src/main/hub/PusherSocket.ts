import { EventEmitter } from 'node:events';
import type { HubRealtimeState, PresenceMember } from '@comitiva/contract';

export interface PusherSocketOptions {
  key: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  /** Signs a private or presence channel for this socket (the hub's /broadcasting/auth). */
  authorize(socketId: string, channel: string): Promise<{ auth: string; channel_data?: string }>;
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect delays in ms; the last one repeats. */
  backoff?: number[];
  log?: (message: string) => void;
}

interface Frame {
  event: string;
  channel?: string;
  data?: unknown;
}

export interface PusherSocketEvents {
  state: [HubRealtimeState];
  event: [channel: string, name: string, data: unknown];
  presence: [channel: string, members: PresenceMember[]];
}

/**
 * A small client of the Pusher protocol (version 7), which Reverb speaks,
 * over the WebSocket built into Node: connect, keepalive, subscribe to
 * private and presence channels (authorized by the hub), and reconnect with
 * backoff, subscribing again to every channel still wanted.
 */
export class PusherSocket extends EventEmitter<PusherSocketEvents> {
  private ws: WebSocket | null = null;
  private socketId: string | null = null;
  private readonly wanted = new Set<string>();
  private readonly presence = new Map<string, Map<string, PresenceMember>>();
  private closed = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private activityMs = 120_000;
  state: HubRealtimeState = 'off';

  constructor(private readonly opts: PusherSocketOptions) {
    super();
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.stopKeepalive();
    this.ws?.close();
    this.ws = null;
    this.socketId = null;
    this.presence.clear();
    this.setState('off');
  }

  subscribe(channel: string): void {
    if (this.wanted.has(channel)) return;
    this.wanted.add(channel);
    if (this.socketId) void this.join(channel);
  }

  unsubscribe(channel: string): void {
    if (!this.wanted.delete(channel)) return;
    this.presence.delete(channel);
    if (this.socketId) this.sendFrame({ event: 'pusher:unsubscribe', data: { channel } });
  }

  private open(): void {
    const { key, host, port, scheme } = this.opts;
    const protocol = scheme === 'https' ? 'wss' : 'ws';
    const url = `${protocol}://${host}:${port}/app/${key}?protocol=7&client=comitiva&version=1`;
    this.setState('connecting');
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch (err) {
      this.log(`cannot open ${url}: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('message', (e) => this.onFrame(String(e.data)));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.socketId = null;
      this.stopKeepalive();
      if (!this.closed) {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    });
    ws.addEventListener('error', () => {
      // `close` follows and reconnects.
    });
  }

  private onFrame(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    const data = typeof frame.data === 'string' ? safeJson(frame.data) : frame.data;
    this.resetKeepalive();
    switch (frame.event) {
      case 'pusher:connection_established': {
        const info = data as { socket_id: string; activity_timeout?: number };
        this.socketId = info.socket_id;
        this.activityMs = Math.max(10, Math.min(info.activity_timeout ?? 120, 120)) * 1000;
        this.attempt = 0;
        this.setState('connected');
        for (const channel of this.wanted) void this.join(channel);
        return;
      }
      case 'pusher:ping':
        this.sendFrame({ event: 'pusher:pong', data: {} });
        return;
      case 'pusher:pong':
        clearTimeout(this.pongTimer);
        return;
      case 'pusher:error':
        this.log(`error from the hub's socket: ${JSON.stringify(data)}`);
        return;
      case 'pusher_internal:subscription_succeeded': {
        if (!frame.channel?.startsWith('presence-')) return;
        const hash = (data as { presence?: { hash?: Record<string, { name?: string }> } })?.presence
          ?.hash;
        const members = new Map<string, PresenceMember>();
        for (const [userId, info] of Object.entries(hash ?? {})) {
          members.set(userId, { userId, name: info?.name ?? '' });
        }
        this.presence.set(frame.channel, members);
        this.emit('presence', frame.channel, [...members.values()]);
        return;
      }
      case 'pusher_internal:member_added':
      case 'pusher_internal:member_removed': {
        const members = frame.channel ? this.presence.get(frame.channel) : undefined;
        if (!members || !frame.channel) return;
        const member = data as { user_id: string; user_info?: { name?: string } };
        if (frame.event === 'pusher_internal:member_added') {
          members.set(member.user_id, {
            userId: member.user_id,
            name: member.user_info?.name ?? '',
          });
        } else {
          members.delete(member.user_id);
        }
        this.emit('presence', frame.channel, [...members.values()]);
        return;
      }
      default:
        if (frame.channel && !frame.event.startsWith('pusher')) {
          this.emit('event', frame.channel, frame.event, data);
        }
    }
  }

  private async join(channel: string): Promise<void> {
    const socketId = this.socketId;
    if (!socketId) return;
    try {
      const signed =
        channel.startsWith('private-') || channel.startsWith('presence-')
          ? await this.opts.authorize(socketId, channel)
          : null;
      if (this.socketId !== socketId || !this.wanted.has(channel)) return;
      this.sendFrame({
        event: 'pusher:subscribe',
        data: { channel, ...(signed ?? {}) },
      });
    } catch (err) {
      this.log(`cannot subscribe to ${channel}: ${(err as Error).message}`);
    }
  }

  private sendFrame(frame: Frame): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const steps = this.opts.backoff ?? [1000, 2000, 4000, 8000, 15_000, 30_000];
    const delay = steps[Math.min(this.attempt, steps.length - 1)]!;
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** After a quiet `activity_timeout`, ping; no pong in 30 s means the socket is dead. */
  private resetKeepalive(): void {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.sendFrame({ event: 'pusher:ping', data: {} });
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => this.ws?.close(), 30_000);
    }, this.activityMs);
  }

  private stopKeepalive(): void {
    clearTimeout(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  private setState(state: HubRealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private log(message: string): void {
    (this.opts.log ?? ((m: string) => console.warn(`PusherSocket: ${m}`)))(message);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
