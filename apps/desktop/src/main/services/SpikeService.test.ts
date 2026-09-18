import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SpikeEvent } from '@comitiva/contract';
import { RunnerClient } from '@comitiva/runner';
import { startFakeAnthropic, type FakeAnthropic } from '@comitiva/runner/testing';
import type { SecretStore } from '../secrets/SecretStore';
import { SPIKE_SECRET_REF, SpikeService } from './SpikeService';

class MemorySecretStore implements SecretStore {
  readonly map = new Map<string, string>();
  async set(ref: string, value: string) {
    this.map.set(ref, value);
  }
  async get(ref: string) {
    return this.map.get(ref) ?? null;
  }
  async has(ref: string) {
    return this.map.has(ref);
  }
  async delete(ref: string) {
    this.map.delete(ref);
  }
}

let fake: FakeAnthropic;
let client: RunnerClient;
let events: SpikeEvent[];
let secrets: MemorySecretStore;
let service: SpikeService;
let latencyLogFile: string;

beforeAll(async () => {
  fake = await startFakeAnthropic();
});
afterAll(() => fake.close());

beforeEach(async () => {
  client = new RunnerClient({
    spawn: () =>
      spawn(process.execPath, [require.resolve('@comitiva/runner/bin')], {
        stdio: ['pipe', 'pipe', 'inherit'],
      }),
  });
  await client.start();
  events = [];
  secrets = new MemorySecretStore();
  latencyLogFile = join(await mkdtemp(join(tmpdir(), 'comitiva-spike-')), 'latency.jsonl');
  service = new SpikeService({
    runner: client,
    secrets,
    emit: (e) => events.push(e),
    latencyLogFile,
    anthropicBaseUrl: fake.url,
  });
});
afterEach(() => client.stop());

const of = (conversationId: string) => events.filter((e) => e.conversationId === conversationId);
const textOf = (conversationId: string) =>
  of(conversationId)
    .filter((e) => e.kind === 'delta')
    .map((e) => (e.kind === 'delta' ? e.text : ''))
    .join('');

describe('SpikeService', () => {
  it('refuses to send without a saved key', async () => {
    await expect(service.send('a', 'hi', 'claude-haiku-4-5')).rejects.toMatchObject({
      code: 'secret_missing',
    });
  });

  it('streams two conversations in parallel and cancels one independently', async () => {
    await service.saveApiKey('sk-test');
    await service.send('a', '[chunks:300] [interval:5]', 'claude-haiku-4-5');
    await service.send('b', '[chunks:40] [interval:5]', 'claude-haiku-4-5');

    await expect.poll(() => of('a').length).toBeGreaterThan(1);
    await expect.poll(() => of('b').length).toBeGreaterThan(1);
    service.cancel('a');

    await expect
      .poll(() => of('a').at(-1))
      .toMatchObject({ kind: 'done', stopReason: 'cancelled' });
    await expect
      .poll(() => of('b').at(-1), { timeout: 5000 })
      .toMatchObject({ kind: 'done', stopReason: 'end_turn' });

    expect(textOf('b')).toBe(Array.from({ length: 40 }, (_, i) => `chunk ${i} `).join(''));
    expect(of('b').find((e) => e.kind === 'usage')).toMatchObject({ outputTokens: 80 });
    expect(textOf('a').length).toBeLessThan(300 * 'chunk 000 '.length);
  });

  it('coalesces deltas into frame-sized batches carrying the runner timestamp', async () => {
    await service.saveApiKey('sk-test');
    await service.send('a', '[chunks:60] [interval:1]', 'claude-haiku-4-5');
    await expect.poll(() => of('a').at(-1)?.kind).toBe('done');
    const deltas = of('a').filter((e) => e.kind === 'delta');
    expect(deltas.length).toBeLessThan(60);
    expect(deltas.every((d) => d.kind === 'delta' && typeof d.runnerTs === 'number')).toBe(true);
  });

  it('keeps history across turns', async () => {
    await service.saveApiKey('sk-test');
    await service.send('a', 'first [chunks:2] [interval:1]', 'claude-haiku-4-5');
    await expect.poll(() => of('a').at(-1)?.kind).toBe('done');
    await service.send('a', 'second [chunks:2] [interval:1]', 'claude-haiku-4-5');
    await expect.poll(() => of('a').filter((e) => e.kind === 'done').length).toBe(2);
    const roles = (fake.requests.at(-1)!.body.messages as Array<{ role: string }>).map(
      (m) => m.role,
    );
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  it('rejects a second send while running', async () => {
    await service.saveApiKey('sk-test');
    await service.send('a', '[chunks:100] [interval:5]', 'claude-haiku-4-5');
    await expect(service.send('a', 'again', 'claude-haiku-4-5')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    service.cancel('a');
  });

  it('forwards provider errors by code only', async () => {
    await service.saveApiKey('sk-test');
    await service.send('a', '[error:429]', 'claude-haiku-4-5');
    await expect
      .poll(() => of('a').at(-1))
      .toEqual({ kind: 'error', conversationId: 'a', code: 'rate_limited', retryable: true });
  });

  it('tests the key through the runner', async () => {
    await secrets.set(SPIKE_SECRET_REF, 'bad-key');
    expect(await service.testApiKey()).toMatchObject({ ok: false, error: { code: 'auth_failed' } });
  });

  it('records latency percentiles', async () => {
    await service.reportLatency('a', [5, 1, 3, 2, 4]);
    const line = JSON.parse((await readFile(latencyLogFile, 'utf8')).trim());
    expect(line).toMatchObject({ conversationId: 'a', n: 5, p50: 3, max: 5, flushMs: 16 });
  });
});
