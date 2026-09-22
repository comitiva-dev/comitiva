import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeGoogle, type FakeGoogle } from '@comitiva/mcp-servers/testing';
import type { RunnerClient } from '@comitiva/runner';
import { GoogleOAuth, googleEndpoints } from '../oauth/GoogleOAuth';
import { MemorySecrets } from '../testing/MemorySecrets';
import {
  GOOGLE_CLIENT_REF,
  GOOGLE_TOKENS_REF,
  GoogleDriveService,
  REFRESH_MARGIN_MS,
} from './GoogleDriveService';

const CLIENT_ID = 'fake-client.apps.googleusercontent.com';

let google: FakeGoogle;
let secrets: MemorySecrets;
let runner: { stopToolServer: ReturnType<typeof vi.fn<RunnerClient['stopToolServer']>> };
let clock: number;
let openExternal: (url: string) => Promise<void>;
let service: GoogleDriveService;

beforeAll(async () => {
  google = await startFakeGoogle({ clientSecret: 'shh', email: 'ana@example.com' });
});
afterAll(() => google.close());
beforeEach(() => {
  google.oauth.deny = false;
  google.oauth.failRefresh = false;
  google.oauth.refreshCount = 0;
  secrets = new MemorySecrets();
  runner = { stopToolServer: vi.fn<RunnerClient['stopToolServer']>().mockResolvedValue(undefined) };
  clock = Date.now();
  openExternal = browser;
  service = new GoogleDriveService({
    secrets,
    runner,
    apiBaseUrl: google.url,
    now: () => clock,
    oauth: new GoogleOAuth({
      endpoints: googleEndpoints(google.url),
      openExternal: (url) => openExternal(url),
      now: () => clock,
    }),
  });
});

async function browser(url: string): Promise<void> {
  const consent = await fetch(url, { redirect: 'manual' });
  await fetch(consent.headers.get('location')!);
}

async function connected(): Promise<void> {
  await service.configure({ clientId: CLIENT_ID, clientSecret: { value: 'shh' } });
  await service.connect();
}

const stored = () => JSON.parse(secrets.values.get(GOOGLE_TOKENS_REF)!) as Record<string, unknown>;

describe('GoogleDriveService: client and connect', () => {
  it('starts not configured, and refuses to connect without a client', async () => {
    expect(await service.status()).toEqual({
      clientConfigured: false,
      clientId: null,
      hasClientSecret: false,
      state: 'disconnected',
      email: null,
    });
    await expect(service.connect()).rejects.toMatchObject({ code: 'oauth_not_configured' });
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'google_not_connected' });
  });

  it('keeps the client in the SecretStore and never returns the secret', async () => {
    const status = await service.configure({
      clientId: ` ${CLIENT_ID} `,
      clientSecret: { value: 'shh' },
    });
    expect(status).toMatchObject({
      clientConfigured: true,
      clientId: CLIENT_ID,
      hasClientSecret: true,
    });
    expect(JSON.stringify(status)).not.toContain('shh');
    expect(JSON.parse(secrets.values.get(GOOGLE_CLIENT_REF)!)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'shh',
    });
    // Saving the same id again keeps the secret.
    await service.configure({ clientId: CLIENT_ID });
    expect(JSON.parse(secrets.values.get(GOOGLE_CLIENT_REF)!).clientSecret).toBe('shh');
  });

  it('connects: tokens and email stored, "connecting" meanwhile, old server stopped', async () => {
    await service.configure({ clientId: CLIENT_ID, clientSecret: { value: 'shh' } });
    let during: string | undefined;
    openExternal = async (url) => {
      during = (await service.status()).state;
      await browser(url);
    };
    const status = await service.connect();
    expect(during).toBe('connecting');
    expect(status).toMatchObject({ state: 'connected', email: 'ana@example.com' });
    expect(stored()).toMatchObject({
      accessToken: expect.stringMatching(/^ya29\./),
      refreshToken: expect.stringMatching(/^1\/\//),
      email: 'ana@example.com',
    });
    expect(JSON.stringify(status)).not.toMatch(/ya29|1\/\//);
    expect(runner.stopToolServer).toHaveBeenCalledWith('google-drive');
  });

  it('can be cancelled, and runs one attempt at a time', async () => {
    await service.configure({ clientId: CLIENT_ID, clientSecret: { value: 'shh' } });
    let opened!: () => void;
    const wasOpened = new Promise<void>((r) => (opened = r));
    openExternal = async () => opened();
    const first = service.connect();
    await wasOpened;
    await expect(service.connect()).rejects.toMatchObject({ code: 'invalid_request' });
    service.cancelConnect();
    await expect(first).rejects.toMatchObject({ code: 'oauth_cancelled' });
    expect((await service.status()).state).toBe('disconnected');
    expect(secrets.values.has(GOOGLE_TOKENS_REF)).toBe(false);
  });

  it('stays disconnected when the user denies access', async () => {
    await service.configure({ clientId: CLIENT_ID, clientSecret: { value: 'shh' } });
    google.oauth.deny = true;
    await expect(service.connect()).rejects.toMatchObject({ code: 'oauth_cancelled' });
    expect((await service.status()).state).toBe('disconnected');
  });
});

describe('GoogleDriveService: tokens for launches', () => {
  it('reuses a token with time left, refreshes one about to expire, once for concurrent callers', async () => {
    await connected();
    const first = stored().accessToken;
    expect(await service.accessToken()).toBe(first);
    expect(google.oauth.refreshCount).toBe(0);

    clock += 3600_000 - REFRESH_MARGIN_MS + 1_000;
    const [a, b] = await Promise.all([service.accessToken(), service.accessToken()]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(google.oauth.refreshCount).toBe(1);
    expect(stored().accessToken).toBe(a);
    expect(await service.accessToken()).toBe(a);
    expect(google.oauth.refreshCount).toBe(1);
  });

  it('asks to reconnect when Google refuses the refresh token, and remembers it', async () => {
    await connected();
    google.oauth.failRefresh = true;
    clock += 3600_000;
    await expect(service.accessToken()).rejects.toMatchObject({
      code: 'google_reconnect_required',
    });
    expect(await service.status()).toMatchObject({
      state: 'reconnect_required',
      email: 'ana@example.com',
    });
    const requests = google.requests.length;
    await expect(service.accessToken()).rejects.toMatchObject({
      code: 'google_reconnect_required',
    });
    expect(google.requests.length).toBe(requests);

    google.oauth.failRefresh = false;
    expect((await service.connect()).state).toBe('connected');
    expect(await service.accessToken()).toMatch(/^ya29\./);
  });
});

describe('GoogleDriveService: disconnect', () => {
  it('revokes at Google, forgets the tokens, stops the server and keeps the client', async () => {
    await connected();
    const refreshToken = stored().refreshToken as string;
    runner.stopToolServer.mockClear();
    const status = await service.disconnect();
    expect(status).toMatchObject({ state: 'disconnected', clientConfigured: true, email: null });
    expect(google.oauth.revoked).toContain(refreshToken);
    expect(secrets.values.has(GOOGLE_TOKENS_REF)).toBe(false);
    expect(runner.stopToolServer).toHaveBeenCalledWith('google-drive');
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'google_not_connected' });
  });

  it('disconnects when the client id changes', async () => {
    await connected();
    const status = await service.configure({ clientId: 'other.apps.googleusercontent.com' });
    expect(status).toMatchObject({
      state: 'disconnected',
      clientId: 'other.apps.googleusercontent.com',
      hasClientSecret: false,
    });
    expect(secrets.values.has(GOOGLE_TOKENS_REF)).toBe(false);
  });

  it('refuses to save anything when the keyring is unavailable', async () => {
    secrets.available = false;
    await expect(
      service.configure({ clientId: CLIENT_ID, clientSecret: { value: 'shh' } }),
    ).rejects.toMatchObject({ code: 'secret_store_unavailable' });
    expect((await service.status()).clientConfigured).toBe(false);
  });
});
