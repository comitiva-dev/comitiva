import { describe, expect, it } from 'vitest';
import { HubClient } from './HubClient';

const client = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>) =>
  new HubClient({
    baseUrl: 'https://hub.example.com',
    token: 'tok',
    fetch: (async (input: URL, init: RequestInit) =>
      respond(input, init)) as unknown as typeof fetch,
  });

describe('HubClient', () => {
  it('sends the token and JSON, with query parameters', async () => {
    let seen: { url: string; auth: string | null; body: unknown } | null = null;
    const c = client((url, init) => {
      seen = {
        url: url.toString(),
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      };
      return Response.json({ ok: 1 });
    });
    expect(await c.request('POST', '/api/v1/x', { query: { a: 'b c' }, body: { n: 1 } })).toEqual({
      ok: 1,
    });
    expect(seen).toEqual({
      url: 'https://hub.example.com/api/v1/x?a=b+c',
      auth: 'Bearer tok',
      body: { n: 1 },
    });
  });

  it("keeps the hub's error code, and maps statuses when there is none", async () => {
    await expect(
      client(() =>
        Response.json(
          { error: { code: 'conversation_busy', message: 'busy', retryable: false } },
          { status: 409 },
        ),
      ).request('POST', '/api/v1/x'),
    ).rejects.toMatchObject({ code: 'conversation_busy', message: 'busy' });
    await expect(
      client(() => Response.json({ error: { code: 'from_the_future' } }, { status: 401 })).request(
        'GET',
        '/x',
      ),
    ).rejects.toMatchObject({ code: 'hub_auth_required' });
    await expect(
      client(() => new Response('oops', { status: 502 })).request('GET', '/x'),
    ).rejects.toMatchObject({
      code: 'hub_unreachable',
      retryable: true,
    });
    await expect(
      client(() => new Response('', { status: 404 })).request('GET', '/x'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reports an unreachable hub as retryable, and 204 as nothing', async () => {
    await expect(
      client(() => {
        throw new TypeError('fetch failed');
      }).request('GET', '/x'),
    ).rejects.toMatchObject({ code: 'hub_unreachable', retryable: true });
    expect(
      await client(() => new Response(null, { status: 204 })).request('POST', '/x'),
    ).toBeUndefined();
    await expect(
      client(() => new Response('<html>', { status: 200 })).request('GET', '/x'),
    ).rejects.toMatchObject({
      code: 'hub_unreachable',
    });
  });

  it('refuses an address that does not answer like a hub', async () => {
    await expect(client(() => Response.json({ hello: 'world' })).meta()).rejects.toMatchObject({
      code: 'hub_incompatible',
    });
  });
});
