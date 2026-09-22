import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGoogle, type FakeGoogle } from '@comitiva/mcp-servers/testing';
import { DRIVE_SCOPE, GoogleOAuth, googleEndpoints, GOOGLE_ENDPOINTS } from './GoogleOAuth';

const CLIENT = { clientId: 'fake-client.apps.googleusercontent.com', clientSecret: 'shh' };

let google: FakeGoogle;
let opened: string[];

beforeAll(async () => {
  google = await startFakeGoogle({ clientSecret: 'shh' });
});
afterAll(() => google.close());
beforeEach(() => {
  opened = [];
  google.oauth.deny = false;
  google.oauth.grantScopes = null;
  google.oauth.failRefresh = false;
});

/** Plays the browser: opens the consent page and follows its redirect to the loopback. */
async function browser(url: string): Promise<void> {
  opened.push(url);
  const consent = await fetch(url, { redirect: 'manual' });
  const location = consent.headers.get('location');
  if (location) await fetch(location);
}

function oauth(openExternal: (url: string) => Promise<void> = browser, timeoutMs?: number) {
  return new GoogleOAuth({
    endpoints: googleEndpoints(google.url),
    openExternal,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

/** The loopback listener refuses connections once the flow is over. */
async function expectClosed(url: string): Promise<void> {
  const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
  await expect(fetch(redirectUri)).rejects.toThrow();
}

describe('GoogleOAuth.authorize (loopback + PKCE)', () => {
  it('gets tokens through the browser, with PKCE the server verifies', async () => {
    const tokens = await oauth().authorize(CLIENT, [DRIVE_SCOPE]);
    expect(tokens).toMatchObject({
      accessToken: expect.stringMatching(/^ya29\./),
      refreshToken: expect.stringMatching(/^1\/\//),
      scope: DRIVE_SCOPE,
    });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);

    const auth = new URL(opened[0]!);
    expect(auth.origin + auth.pathname).toBe(`${google.url}/o/oauth2/v2/auth`);
    const q = Object.fromEntries(auth.searchParams);
    expect(q).toMatchObject({
      client_id: CLIENT.clientId,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(q.state!.length).toBeGreaterThanOrEqual(20);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The client secret goes to the token endpoint, never into the browser URL.
    expect(opened[0]).not.toContain('shh');
    const exchange = google.requests.findLast((r) => r.path === '/token')!;
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('shh');
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expectClosed(opened[0]!);
  });

  it('ignores a request with the wrong state and keeps waiting for the real one', async () => {
    let stray: number | undefined;
    const tokens = await oauth(async (url) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      stray = (await fetch(`${redirectUri}/?code=evil&state=guess`)).status;
      expect((await fetch(`${redirectUri}/favicon.ico`)).status).toBe(404);
      await browser(url);
    }).authorize(CLIENT, [DRIVE_SCOPE]);
    expect(stray).toBe(400);
    expect(tokens.accessToken).toMatch(/^ya29\./);
  });

  it('is cancelled when the user denies access', async () => {
    google.oauth.deny = true;
    await expect(oauth().authorize(CLIENT, [DRIVE_SCOPE])).rejects.toMatchObject({
      code: 'oauth_cancelled',
    });
    await expectClosed(opened[0]!);
  });

  it('fails when Drive access is not granted', async () => {
    google.oauth.grantScopes = 'openid';
    await expect(oauth().authorize(CLIENT, [DRIVE_SCOPE])).rejects.toMatchObject({
      code: 'oauth_failed',
      message: expect.stringContaining(DRIVE_SCOPE),
    });
  });

  it('fails when the client secret is wrong, without echoing it', async () => {
    const err = await oauth()
      .authorize({ ...CLIENT, clientSecret: 'wrong-secret' }, [DRIVE_SCOPE])
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'oauth_failed' });
    expect((err as Error).message).not.toContain('wrong-secret');
  });

  it('times out when the browser never comes back, and closes the listener', async () => {
    const started = Date.now();
    await expect(
      oauth(async (url) => void opened.push(url), 100).authorize(CLIENT, [DRIVE_SCOPE]),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    await expectClosed(opened[0]!);
  });

  it('is cancelled through the signal', async () => {
    const abort = new AbortController();
    const pending = oauth(async (url) => {
      opened.push(url);
      setTimeout(() => abort.abort(), 10);
    }).authorize(CLIENT, [DRIVE_SCOPE], abort.signal);
    await expect(pending).rejects.toMatchObject({ code: 'oauth_cancelled' });
    await expectClosed(opened[0]!);
  });
});

describe('GoogleOAuth.refresh and revoke', () => {
  it('refreshes, then asks to reconnect when Google refuses the refresh token', async () => {
    const client = oauth();
    const tokens = await client.authorize(CLIENT, [DRIVE_SCOPE]);
    const fresh = await client.refresh(CLIENT, tokens.refreshToken);
    expect(fresh.accessToken).not.toBe(tokens.accessToken);
    expect(fresh.expiresAt).toBeGreaterThan(Date.now());

    google.oauth.failRefresh = true;
    await expect(client.refresh(CLIENT, tokens.refreshToken)).rejects.toMatchObject({
      code: 'google_reconnect_required',
    });
  });

  it('revokes at Google, and never throws doing it', async () => {
    const client = oauth();
    const tokens = await client.authorize(CLIENT, [DRIVE_SCOPE]);
    await client.revoke(tokens.refreshToken);
    expect(google.oauth.revoked).toContain(tokens.refreshToken);
    google.oauth.failRefresh = false;
    await expect(client.refresh(CLIENT, tokens.refreshToken)).rejects.toMatchObject({
      code: 'google_reconnect_required',
    });
    const offline = new GoogleOAuth({
      endpoints: googleEndpoints('http://127.0.0.1:1'),
      openExternal: browser,
    });
    await expect(offline.revoke('x')).resolves.toBeUndefined();
    await expect(offline.refresh(CLIENT, 'x')).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it("defaults to Google's own endpoints", () => {
    expect(googleEndpoints()).toBe(GOOGLE_ENDPOINTS);
    expect(GOOGLE_ENDPOINTS.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(googleEndpoints(`${google.url}/`).tokenUrl).toBe(`${google.url}/token`);
  });
});
