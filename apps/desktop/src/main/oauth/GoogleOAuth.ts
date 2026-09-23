import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError } from '@comitiva/contract';

/**
 * OAuth 2.0 for installed apps (Google), with a loopback redirect and PKCE
 * (RFC 8252, RFC 7636). No Electron import: the browser is opened through the
 * injected `openExternal`, so tests drive the flow against a fake server.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Google's REST API origin (the Drive server's default too). */
export const GOOGLE_API_BASE_URL = 'https://www.googleapis.com';

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
};

/** Google's endpoints, or all three under one origin (the fake server in tests). */
export function googleEndpoints(baseUrl?: string): OAuthEndpoints {
  if (!baseUrl) return GOOGLE_ENDPOINTS;
  const base = baseUrl.replace(/\/+$/, '');
  return {
    authUrl: `${base}/o/oauth2/v2/auth`,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
  };
}

export interface OAuthClient {
  clientId: string;
  /** Google's "Desktop app" clients come with one; it is sent when present. */
  clientSecret?: string | undefined;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

export interface GoogleOAuthDeps {
  endpoints: OAuthEndpoints;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long to wait for the browser to come back (default 5 min). */
  timeoutMs?: number;
  /** The text of the page the browser lands on (localized by the shell). */
  resultPage?: (connected: boolean) => { title: string; body: string };
}

const ENGLISH_PAGES = (connected: boolean) =>
  connected
    ? {
        title: 'Google Drive is connected',
        body: 'You can close this tab and go back to Comitiva.',
      }
    : { title: 'Google Drive was not connected', body: 'Go back to Comitiva to try again.' };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Comitiva</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>` +
  `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;

interface Redirect {
  code?: string;
  error?: string;
}

export class GoogleOAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GoogleOAuthDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Opens the consent page in the browser and waits for the redirect to a
   * one-shot listener on 127.0.0.1 (random port). Only a request carrying the
   * right `state` counts; the code is exchanged with the PKCE verifier.
   * Rejects with oauth_cancelled (user denied or `signal` aborted), timeout,
   * or oauth_failed (a bad answer, or the Drive scope not granted).
   */
  async authorize(client: OAuthClient, scopes: string[], signal?: AbortSignal): Promise<TokenSet> {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');

    const { server, redirectUri, redirect } = await listen(
      state,
      this.deps.resultPage ?? ENGLISH_PAGES,
    );
    try {
      const url = new URL(this.deps.endpoints.authUrl);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      await this.deps.openExternal(url.toString());

      const answer = await raceAbort(redirect, signal, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (answer.error) {
        throw answer.error === 'access_denied'
          ? new AppError('oauth_cancelled', 'Access was not granted in the browser')
          : new AppError('oauth_failed', `Google answered ${answer.error}`);
      }
      const tokens = await this.tokenRequest({
        grant_type: 'authorization_code',
        code: answer.code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      });
      if (!tokens.refresh_token) {
        throw new AppError('oauth_failed', 'Google did not return a refresh token');
      }
      const scope = tokens.scope ?? scopes.join(' ');
      const granted = scope.split(' ');
      const missing = scopes.filter((s) => !granted.includes(s));
      if (missing.length) {
        throw new AppError('oauth_failed', `Access was not granted to: ${missing.join(', ')}`);
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: this.now() + tokens.expires_in * 1000,
        scope,
      };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  /** A new access token. A revoked or expired refresh token → google_reconnect_required. */
  async refresh(
    client: OAuthClient,
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: number; scope: string | undefined }> {
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    });
    return {
      accessToken: tokens.access_token,
      expiresAt: this.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
    };
  }

  /** Revokes a token at Google. Best effort: failures are ignored. */
  async revoke(token: string): Promise<void> {
    try {
      await this.fetchImpl(this.deps.endpoints.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // offline or already revoked: forgetting the token locally is what matters
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.deps.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AppError(
        'provider_unavailable',
        `Google is unreachable: ${(err as Error).message}`,
        {
          retryable: true,
        },
      );
    }
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const what = [body.error, body.error_description].filter(Boolean).join(': ');
      if (body.error === 'invalid_grant' && params.grant_type === 'refresh_token') {
        throw new AppError(
          'google_reconnect_required',
          `Google no longer accepts the saved sign-in (${what}). Connect Google Drive again.`,
        );
      }
      throw new AppError(
        'oauth_failed',
        `Google refused the token request (${what || res.status})`,
      );
    }
    return body as TokenResponse;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * A listener on 127.0.0.1 for the redirect. Requests without the right state
 * (a stray tab, a port scan) get a 400 and are ignored; the first one with it
 * settles `redirect`.
 */
async function listen(
  state: string,
  page: (connected: boolean) => { title: string; body: string },
): Promise<{ server: Server; redirectUri: string; redirect: Promise<Redirect> }> {
  let settle!: (r: Redirect) => void;
  const redirect = new Promise<Redirect>((resolve) => (settle = resolve));
  let done = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
      res.writeHead(url.pathname === '/' ? 400 : 404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const ok = !done && !error && !!code;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    const { title, body } = page(ok);
    res.end(PAGE(title, body));
    if (done) return;
    done = true;
    settle(error ? { error } : code ? { code } : { error: 'no_code' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, redirectUri: `http://127.0.0.1:${port}`, redirect };
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppError('timeout', 'The browser did not come back in time')),
      ms,
    );
    const onAbort = () => reject(new AppError('oauth_cancelled', 'Connecting was cancelled'));
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}
