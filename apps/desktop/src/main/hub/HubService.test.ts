import { describe, expect, it } from 'vitest';
import { FakeHub } from '../testing/FakeHub';
import { MemorySecrets } from '../testing/MemorySecrets';
import { HubService, HUB_TOKEN_REF, type HubSettings } from './HubService';

function service(fetchImpl: typeof fetch, settings: HubSettings = { url: null, user: null }) {
  const store = { value: settings };
  const secrets = new MemorySecrets();
  const hub = new HubService({
    settings: { get: () => store.value, set: (s) => (store.value = s) },
    secrets,
    deviceName: 'test',
    fetch: fetchImpl,
    WebSocketImpl: new FakeHub().WebSocket,
    log: () => {},
  });
  return { hub, secrets, store };
}

describe('HubService', () => {
  it('checks the hub before keeping its address, and refuses another API version', async () => {
    const fake = new FakeHub();
    const onlyFake: typeof fetch = async (input, init) => {
      if (!String(input).startsWith(fake.url)) throw new TypeError('fetch failed');
      return fake.fetch(input, init);
    };
    const { hub, store } = service(onlyFake);
    await expect(hub.configure('https://nowhere.example')).rejects.toMatchObject({
      code: 'hub_unreachable',
    });
    expect(store.value.url).toBeNull();
    const newer: typeof fetch = async () =>
      Response.json({
        apiVersion: 2,
        edition: 'community',
        contractVersion: 'contract-v9.0.0',
        capabilities: { execution: true, registration: 'open' },
        realtime: null,
      });
    await expect(service(newer).hub.configure(fake.url)).rejects.toMatchObject({
      code: 'hub_incompatible',
    });
    const status = await hub.configure(`${fake.url}/`);
    expect(status.url).toBe(fake.url);
    expect(status.meta?.apiVersion).toBe(1);
    expect(store.value.url).toBe(fake.url);
  });

  it('keeps the token in the secret store, never in the status or the settings', async () => {
    const fake = new FakeHub();
    const { hub, secrets, store } = service(fake.fetch);
    await hub.configure(fake.url);
    const status = await hub.register({
      name: 'Ana',
      email: 'ana@example.com',
      password: 'long enough',
    });
    const token = await secrets.get(HUB_TOKEN_REF);
    expect(token).toBeTruthy();
    expect(status.user?.email).toBe('ana@example.com');
    expect(JSON.stringify(status)).not.toContain(token!);
    expect(JSON.stringify(store.value)).not.toContain(token!);
  });

  it('signs out when the hub rejects the token, and on another hub', async () => {
    const fake = new FakeHub();
    const { hub, secrets } = service(fake.fetch);
    await hub.configure(fake.url);
    await hub.register({ name: 'Ana', email: 'ana@example.com', password: 'long enough' });
    await secrets.set(HUB_TOKEN_REF, 'forged');
    // The service keeps its own copy until restart; forge that too.
    (hub as unknown as { token: string }).token = 'forged';
    await expect(hub.request({ method: 'GET', path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'hub_auth_required',
    });
    expect(hub.status().user).toBeNull();
    expect(await secrets.get(HUB_TOKEN_REF)).toBeNull();

    await hub.login({ email: 'ana@example.com', password: 'long enough' });
    expect(hub.status().user).not.toBeNull();
    const other: typeof fetch = async (input, init) =>
      fake.fetch(String(input).replace('http://other-hub.test', fake.url), init);
    (hub as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = other;
    await hub.configure('http://other-hub.test');
    expect(hub.status().user).toBeNull();
  });

  it('restores the session at start and checks it with the hub', async () => {
    const fake = new FakeHub();
    const first = service(fake.fetch);
    await first.hub.configure(fake.url);
    await first.hub.register({ name: 'Ana', email: 'ana@example.com', password: 'long enough' });
    const token = await first.secrets.get(HUB_TOKEN_REF);

    const again = service(fake.fetch, first.store.value);
    await again.secrets.set(HUB_TOKEN_REF, token!);
    await again.hub.init();
    expect(again.hub.status().user?.email).toBe('ana@example.com');
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.requests).toContain('GET /api/v1/me');
    again.hub.close();
    first.hub.close();
  });
});
