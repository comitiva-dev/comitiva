import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent, RunnerEvent } from '@comitiva/contract';
import { RunnerServer } from '../src/server/RunnerServer.js';
import { LineSplitter, encodeLine } from '../src/util/jsonl.js';
import { createLogger } from '../src/util/logger.js';
import {
  anthropicConnection,
  ollamaConnection,
  startFakeProviders,
  testAgent,
  userText,
  type FakeProviders,
} from '../src/testing/index.js';

let fake: FakeProviders;
beforeAll(async () => {
  fake = await startFakeProviders();
});
afterAll(() => fake.close());

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: RunnerEvent[] = [];
  const splitter = new LineSplitter((l) => events.push(JSON.parse(l) as RunnerEvent));
  output.on('data', (c: Buffer) => splitter.push(c));
  let exited = false;
  const server = new RunnerServer({
    input,
    output,
    logger: createLogger('silent'),
    onExit: () => (exited = true),
  });
  server.start();
  const send = (msg: unknown) => input.write(typeof msg === 'string' ? msg : encodeLine(msg));
  const response = (id: string) =>
    expect
      .poll(() => events.find((e) => e.type === 'response' && e.id === id))
      .toBeDefined()
      .then(() => events.find((e) => e.type === 'response' && e.id === id)!);
  const runEvents = (runId: string) =>
    events.filter(
      (e): e is RunEvent => e.type.startsWith('run.') && (e as RunEvent).runId === runId,
    );
  return { input, events, send, response, runEvents, server, exited: () => exited };
}

function runStart(id: string, runId: string, text: string) {
  return {
    id,
    type: 'run.start',
    runId,
    conversationId: `conv-${runId}`,
    agent: testAgent(),
    connection: anthropicConnection(fake.url),
    secret: 'sk-test',
    messages: [userText(`conv-${runId}`, text)],
  };
}

describe('RunnerServer', () => {
  it('answers ping with version and protocol version', async () => {
    const h = harness();
    h.send({ id: '1', type: 'ping' });
    expect(await h.response('1')).toMatchObject({
      ok: true,
      result: { version: '0.1.0', protocolVersion: 1 },
    });
  });

  it('rejects invalid requests with invalid_request, echoing the id', async () => {
    const h = harness();
    h.send({ id: '7', type: 'run.start' });
    expect(await h.response('7')).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('reports malformed lines as a log event and keeps going', async () => {
    const h = harness();
    h.send('this is not json\n');
    h.send({ id: '2', type: 'ping' });
    await h.response('2');
    expect(h.events.some((e) => e.type === 'log' && e.level === 'warn')).toBe(true);
  });

  it('answers connection.listModels with the adapter result', async () => {
    const h = harness();
    h.send({
      id: 'm1',
      type: 'connection.listModels',
      connection: ollamaConnection(fake.urls.ollama),
    });
    expect(await h.response('m1')).toMatchObject({
      ok: true,
      result: [{ id: 'llama-fake:latest' }, { id: 'qwen-fake:7b' }],
    });
    h.send({
      id: 'm2',
      type: 'connection.listModels',
      connection: anthropicConnection(fake.url),
      secret: 'bad-key',
    });
    expect(await h.response('m2')).toMatchObject({
      ok: false,
      error: { code: 'auth_failed', retryable: false },
    });
  });

  it('stops an unknown tool server and ignores an approval for an unknown run', async () => {
    const h = harness();
    h.send({ id: '3', type: 'toolServer.stop', toolServerId: 'fs' });
    expect(await h.response('3')).toMatchObject({ ok: true, result: {} });
    h.send({ id: '4', type: 'run.approval', runId: 'gone', toolUseId: 't', decision: 'allow' });
    expect(await h.response('4')).toMatchObject({ ok: true, result: {} });
  });

  it('runs two streams concurrently and cancels one without affecting the other', async () => {
    const h = harness();
    h.send(runStart('a', 'run-a', 'first [chunks:100] [interval:5]'));
    h.send(runStart('b', 'run-b', 'second [chunks:30] [interval:5]'));
    await h.response('a');
    await h.response('b');

    // Both are streaming before either finishes.
    await expect.poll(() => h.runEvents('run-a').length).toBeGreaterThan(3);
    await expect.poll(() => h.runEvents('run-b').length).toBeGreaterThan(3);

    h.send({ id: 'c', type: 'run.cancel', runId: 'run-a' });
    expect(await h.response('c')).toMatchObject({ ok: true, result: { cancelled: true } });

    await expect.poll(() => h.runEvents('run-a').at(-1)?.type).toBe('run.done');
    await expect.poll(() => h.runEvents('run-b').at(-1)?.type, { timeout: 5000 }).toBe('run.done');

    const a = h.runEvents('run-a');
    const b = h.runEvents('run-b');
    expect(a.at(-1)).toMatchObject({ stopReason: 'cancelled' });
    expect(b.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(b.filter((e) => e.type === 'run.text_delta')).toHaveLength(30);
    expect(a.filter((e) => e.type === 'run.text_delta').length).toBeLessThan(100);
    // Every event carries a timestamp.
    expect([...a, ...b].every((e) => typeof e.ts === 'number')).toBe(true);
  });

  it('reports provider errors as run.error with a stable code', async () => {
    const h = harness();
    h.send(runStart('e', 'run-e', '[error:401]'));
    await expect
      .poll(() => h.runEvents('run-e').at(-1))
      .toMatchObject({
        type: 'run.error',
        code: 'auth_failed',
        retryable: false,
      });
  });

  it('rejects a duplicate runId', async () => {
    const h = harness();
    h.send(runStart('d1', 'run-d', '[chunks:50] [interval:5]'));
    h.send(runStart('d2', 'run-d', 'again'));
    expect(await h.response('d2')).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    h.send({ id: 'd3', type: 'run.cancel', runId: 'run-d' });
  });

  it('shuts down on request, cancelling active runs', async () => {
    const h = harness();
    h.send(runStart('s1', 'run-s', '[chunks:200] [interval:5]'));
    await expect.poll(() => h.runEvents('run-s').length).toBeGreaterThan(1);
    h.send({ id: 's2', type: 'shutdown' });
    await h.response('s2');
    await expect.poll(() => h.exited()).toBe(true);
    expect(h.runEvents('run-s').at(-1)).toMatchObject({
      type: 'run.done',
      stopReason: 'cancelled',
    });
  });

  it('stops when its input closes', async () => {
    const h = harness();
    h.input.end();
    await expect.poll(() => h.exited()).toBe(true);
  });
});
