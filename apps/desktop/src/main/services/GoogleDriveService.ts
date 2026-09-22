import {
  AppError,
  GOOGLE_DRIVE_TOOL_SERVER_ID,
  type GoogleDriveConfigureInput,
  type GoogleDriveStatus,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import { DRIVE_SCOPE, type GoogleOAuth, type OAuthClient } from '../oauth/GoogleOAuth';
import type { SecretStore } from '../secrets/SecretStore';

/** The user's own OAuth client, `{ clientId, clientSecret? }`. */
export const GOOGLE_CLIENT_REF = 'google:oauthClient';
/** The account's tokens and email (one JSON value). */
export const GOOGLE_TOKENS_REF = 'google:tokens';

/** Refresh when less than this is left, so a run starts with at least this much. */
export const REFRESH_MARGIN_MS = 15 * 60_000;

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  email: string | null;
  /** Google refused the refresh token: the user must connect again. */
  reconnectRequired?: boolean;
}

export interface GoogleDriveServiceDeps {
  secrets: SecretStore;
  oauth: GoogleOAuth;
  runner: Pick<RunnerClient, 'stopToolServer'>;
  /** Drive API origin, for the account email (tests point it at a fake). */
  apiBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The Google account behind the built-in Drive server (one per app). OAuth
 * happens here, in main; tokens live only in the SecretStore and reach the
 * server as env when it starts (ADR 0010). Before each launch the access token
 * is refreshed if it would expire within 15 minutes; a new token means a new
 * launch, so the runner replaces the idle old instance.
 */
export class GoogleDriveService {
  private connecting: AbortController | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GoogleDriveServiceDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async status(): Promise<GoogleDriveStatus> {
    const client = await this.client();
    const tokens = await this.tokens();
    return {
      clientConfigured: client !== null,
      clientId: client?.clientId ?? null,
      hasClientSecret: !!client?.clientSecret,
      state: this.connecting
        ? 'connecting'
        : !tokens
          ? 'disconnected'
          : tokens.reconnectRequired
            ? 'reconnect_required'
            : 'connected',
      email: tokens?.email ?? null,
    };
  }

  /**
   * Saves the OAuth client. The secret is replaced by `{ value }` and kept
   * otherwise. A different client id disconnects the account (its tokens
   * belong to the old client).
   */
  async configure(input: GoogleDriveConfigureInput): Promise<GoogleDriveStatus> {
    const current = await this.client();
    const clientId = input.clientId.trim();
    if (current && current.clientId !== clientId) await this.disconnect();
    const secret = input.clientSecret;
    const clientSecret =
      secret && 'value' in secret
        ? secret.value.trim()
        : current?.clientId === clientId
          ? current.clientSecret
          : undefined;
    const next: OAuthClient = { clientId, ...(clientSecret ? { clientSecret } : {}) };
    await this.deps.secrets.set(GOOGLE_CLIENT_REF, JSON.stringify(next));
    return this.status();
  }

  /** Runs the browser flow and stores the tokens. One attempt at a time. */
  async connect(): Promise<GoogleDriveStatus> {
    if (this.connecting) {
      throw new AppError('invalid_request', 'Already waiting for the browser');
    }
    const client = await this.client();
    if (!client) {
      throw new AppError('oauth_not_configured', 'Add your Google OAuth client first');
    }
    const abort = new AbortController();
    this.connecting = abort;
    try {
      const set = await this.deps.oauth.authorize(client, [DRIVE_SCOPE], abort.signal);
      const previous = await this.tokens();
      await this.saveTokens({ ...set, email: await this.email(set.accessToken) });
      if (previous && previous.refreshToken !== set.refreshToken) {
        void this.deps.oauth.revoke(previous.refreshToken);
      }
      this.stopServer();
    } finally {
      this.connecting = null;
    }
    return this.status();
  }

  cancelConnect(): void {
    this.connecting?.abort();
  }

  /** Revokes the tokens (best effort) and forgets them. The client stays. */
  async disconnect(): Promise<GoogleDriveStatus> {
    const tokens = await this.tokens();
    if (tokens) {
      await this.deps.secrets.delete(GOOGLE_TOKENS_REF);
      this.stopServer();
      await this.deps.oauth.revoke(tokens.refreshToken);
    }
    return this.status();
  }

  /**
   * An access token valid for at least REFRESH_MARGIN_MS, for a server
   * launch. Throws google_not_connected or google_reconnect_required.
   * Concurrent callers share one refresh.
   */
  async accessToken(): Promise<string> {
    const tokens = await this.tokens();
    if (!tokens) {
      throw new AppError('google_not_connected', 'Google Drive is not connected');
    }
    if (tokens.reconnectRequired) {
      throw new AppError('google_reconnect_required', 'Connect Google Drive again');
    }
    if (tokens.expiresAt - this.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(tokens: StoredTokens): Promise<string> {
    const client = await this.client();
    if (!client) throw new AppError('oauth_not_configured', 'Add your Google OAuth client first');
    try {
      const fresh = await this.deps.oauth.refresh(client, tokens.refreshToken);
      await this.saveTokens({
        ...tokens,
        accessToken: fresh.accessToken,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope ?? tokens.scope,
      });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof AppError && err.code === 'google_reconnect_required') {
        await this.saveTokens({ ...tokens, reconnectRequired: true });
      }
      throw err;
    }
  }

  /** The account email, for the UI. A failure here does not fail the connect. */
  private async email(accessToken: string): Promise<string | null> {
    try {
      const url = `${this.deps.apiBaseUrl.replace(/\/+$/, '')}/drive/v3/about?fields=user(emailAddress)`;
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { user?: { emailAddress?: string } };
      return body.user?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  private stopServer(): void {
    this.deps.runner.stopToolServer(GOOGLE_DRIVE_TOOL_SERVER_ID).catch(() => {});
  }

  private async client(): Promise<OAuthClient | null> {
    return parse<OAuthClient>(await this.deps.secrets.get(GOOGLE_CLIENT_REF).catch(() => null));
  }

  private async tokens(): Promise<StoredTokens | null> {
    return parse<StoredTokens>(await this.deps.secrets.get(GOOGLE_TOKENS_REF).catch(() => null));
  }

  private saveTokens(tokens: StoredTokens): Promise<void> {
    return this.deps.secrets.set(GOOGLE_TOKENS_REF, JSON.stringify(tokens));
  }
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
