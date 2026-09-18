import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '@comitiva/contract';
import { RunnerClient } from '../src/client/RunnerClient.js';
import {
  anthropicConnection,
  fakeConnections,
  startFakeProviders,
  testAgent,
  userText,
  type FakeProviders,
} from '../src/testing/index.js';

// Exercises the real bundled binary (built by the test script) as a child process.
const binPath = fileURLToPath(new URL('../dist/bin.cjs', import.meta.url));

let fake: FakeProviders;
const clients: RunnerClient[] = [];

beforeAll(async () => {
  fake = await startFakeProviders();
});
afterAll(() => fake.close());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});

function newClient() {
  const client = new RunnerClient({
    spawn: () => spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'inherit'] }),
    requestTimeoutMs: 5000,
  });
  const events: RunEvent[] = [];
  client.on('run.event', (e) => events.push(e));
  clients.push(client);
  return { client, events, of: (runId: string) => events.filter((e) => e.runId === runId) };
}

function payload(conversationId: string, text: string) {
  return {
    conversationId,
    agent: testAgent(),
    connection: anthropicConnection(fake.url),
    secret: 'sk-test',
    messages: [userText(conversationId, text)],
  };
}

describe('RunnerClient + runner binary', () => {
  it('starts the process and pings it', async () => {
    const { client } = newClient();
    expect(await client.start()).toEqual({ version: '0.1.0', protocolVersion: 1 });
  });

  it('streams two runs in parallel and cancels one independently', async () => {
    const { client, of } = newClient();
    await client.start();
    const a = client.startRun(payload('conv-a', '[chunks:200] [interval:5]'));
    const b = client.startRun(payload('conv-b', '[chunks:20] [interval:5]'));

    await expect.poll(() => of(a.runId).length).toBeGreaterThan(2);
    client.cancelRun(a.runId);

    await expect.poll(() => of(a.runId).at(-1)?.type).toBe('run.done');
    await expect.poll(() => of(b.runId).at(-1)?.type).toBe('run.done');
    expect(of(a.runId).at(-1)).toMatchObject({ stopReason: 'cancelled' });
    expect(of(b.runId).at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(of(b.runId).find((e) => e.type === 'run.usage')).toMatchObject({ outputTokens: 40 });
    expect(client.activeRunIds()).toEqual([]);
  });

  it('tests a connection through the runner', async () => {
    const { client } = newClient();
    await client.start();
    const ok = await client.testConnection({
      type: 'connection.test',
      connection: anthropicConnection(fake.url),
      secret: 'sk-test',
    });
    expect(ok.ok).toBe(true);
  });

  describe.each(['anthropic', 'openai-compatible', 'google', 'ollama'] as const)(
    '%s through the binary',
    (provider) => {
      const connection = () => fakeConnections(fake.urls).find((c) => c.provider === provider)!;
      const secret = provider === 'ollama' ? undefined : 'sk-test';

      it('tests the connection', async () => {
        const { client } = newClient();
        await client.start();
        const ok = await client.testConnection({
          type: 'connection.test',
          connection: connection(),
          ...(secret ? { secret } : {}),
        });
        expect(ok).toMatchObject({ ok: true });
        const bad = await client.testConnection({
          type: 'connection.test',
          connection: connection(),
          secret: 'bad-key',
        });
        expect(bad).toMatchObject({ ok: false, error: { code: 'auth_failed', retryable: false } });
      });

      it('lists models', async () => {
        const { client } = newClient();
        await client.start();
        const models = await client.listModels({
          type: 'connection.listModels',
          connection: connection(),
          ...(secret ? { secret } : {}),
        });
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((m) => m.id !== '')).toBe(true);
        await expect(
          client.listModels({
            type: 'connection.listModels',
            connection: connection(),
            secret: 'bad-key',
          }),
        ).rejects.toMatchObject({ code: 'auth_failed' });
      });

      it('streams a run with exact usage', async () => {
        const { client, of } = newClient();
        await client.start();
        const { runId } = client.startRun({
          conversationId: `conv-${provider}`,
          agent: testAgent({ model: null }),
          connection: connection(),
          ...(secret ? { secret } : {}),
          messages: [userText(`conv-${provider}`, '[chunks:5] [interval:1]')],
        });
        await expect.poll(() => of(runId).at(-1)?.type).toBe('run.done');
        const events = of(runId);
        expect(events.filter((e) => e.type === 'run.text_delta')).toHaveLength(5);
        expect(events.at(-2)).toMatchObject({
          type: 'run.usage',
          outputTokens: 10,
          estimated: false,
        });
        expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
      });
    },
  );

  it('runs all four providers in parallel and cancels one without affecting the others', async () => {
    const { client, of } = newClient();
    await client.start();
    const runs = fakeConnections(fake.urls).map((connection) => {
      const chunks = connection.provider === 'ollama' ? 400 : 40;
      return {
        provider: connection.provider,
        ...client.startRun({
          conversationId: `conv-p-${connection.provider}`,
          agent: testAgent({ model: null }),
          connection,
          ...(connection.provider === 'ollama' ? {} : { secret: 'sk-test' }),
          messages: [userText('c', `[chunks:${chunks}] [interval:5]`)],
        }),
      };
    });
    // All four stream at the same time.
    for (const r of runs) await expect.poll(() => of(r.runId).length).toBeGreaterThan(2);
    const ollama = runs.find((r) => r.provider === 'ollama')!;
    client.cancelRun(ollama.runId);

    for (const r of runs) {
      await expect.poll(() => of(r.runId).at(-1)?.type, { timeout: 5000 }).toBe('run.done');
    }
    for (const r of runs) {
      const events = of(r.runId);
      if (r === ollama) {
        expect(events.at(-1)).toMatchObject({ stopReason: 'cancelled' });
        expect(events.at(-2)).toMatchObject({ type: 'run.usage', estimated: true });
        expect(events.filter((e) => e.type === 'run.text_delta').length).toBeLessThan(400);
      } else {
        expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
        expect(events.filter((e) => e.type === 'run.text_delta')).toHaveLength(40);
      }
    }
    await expect.poll(() => fake.aborted).toBeGreaterThan(0);
  });

  it('turns a crash into run.error(runner_crashed) for active runs and emits crash', async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const client = new RunnerClient({
      spawn: () =>
        (child = spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'inherit'] })),
    });
    clients.push(client);
    const events: RunEvent[] = [];
    client.on('run.event', (e) => events.push(e));
    const crashed = new Promise<void>((resolve) => client.once('crash', () => resolve()));
    await client.start();

    const { runId } = client.startRun(payload('conv-c', '[chunks:500] [interval:5]'));
    await expect.poll(() => events.length).toBeGreaterThan(1);
    child!.kill('SIGKILL');
    await crashed;

    expect(events.at(-1)).toMatchObject({
      type: 'run.error',
      runId,
      code: 'runner_crashed',
      retryable: true,
    });
    expect(client.running).toBe(false);
    await expect(client.request({ type: 'ping' })).rejects.toMatchObject({
      code: 'runner_unavailable',
    });

    // A supervisor restarts by calling start() again.
    await client.start();
    expect(client.running).toBe(true);
  });

  it('reports start failures of a run as run.error', async () => {
    const { client, of } = newClient();
    await client.start();
    const { runId } = client.startRun({
      ...payload('conv-x', 'hi'),
      agent: testAgent({ model: null }),
      connection: { ...anthropicConnection(fake.url), config: {} },
    });
    await expect
      .poll(() => of(runId).at(-1))
      .toMatchObject({ type: 'run.error', code: 'invalid_request' });
  });

  it('stops gracefully', async () => {
    const { client } = newClient();
    await client.start();
    const exited = new Promise<void>((resolve) => client.once('exit', () => resolve()));
    await client.stop();
    await exited;
    expect(client.running).toBe(false);
  });
});
