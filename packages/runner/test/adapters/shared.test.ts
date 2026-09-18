import { describe, expect, it } from 'vitest';
import { AppError } from '@comitiva/contract';
import {
  UsageTracker,
  httpError,
  networkError,
  probe,
  streamTurn,
  withDeadline,
} from '../../src/providers/api/shared.js';
import type { AdapterEvent } from '../../src/providers/ProviderAdapter.js';

const never = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

describe('httpError', () => {
  it.each([
    [401, 'auth_failed', false],
    [403, 'auth_failed', false],
    [408, 'timeout', true],
    [429, 'rate_limited', true],
    [400, 'provider_error', false],
    [404, 'provider_error', false],
    [500, 'provider_unavailable', true],
    [502, 'provider_unavailable', true],
    [529, 'provider_unavailable', true],
  ] as const)('%i → %s', (status, code, retryable) => {
    const e = httpError(status, 'x');
    expect({ code: e.code, retryable: e.retryable }).toEqual({ code, retryable });
  });
});

describe('networkError', () => {
  it('distinguishes timeouts from other socket failures', () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(networkError(refused)).toMatchObject({ code: 'provider_unavailable', retryable: true });
    const timedOut = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
    });
    expect(networkError(timedOut)).toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('withDeadline / probe', () => {
  it('turns a missed deadline into a retryable timeout', async () => {
    await expect(withDeadline(never, AppError.from, 20)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    expect(await probe(never, AppError.from, 20)).toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    });
  });

  it('maps other failures with the adapter mapping', async () => {
    const r = await probe(
      () => Promise.reject(new Error('boom')),
      () => httpError(429, 'slow down'),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } });
  });
});

describe('UsageTracker', () => {
  it('is exact only when final input and output are known', () => {
    const u = new UsageTracker(50);
    u.addText('12345678');
    expect(u.event()).toEqual({
      type: 'run.usage',
      inputTokens: 50,
      outputTokens: 2,
      estimated: true,
    });
    u.report({ input: 10, output: 1 });
    expect(u.event()).toMatchObject({ inputTokens: 10, outputTokens: 2, estimated: true });
    u.report({ output: 9, final: true });
    expect(u.event()).toEqual({
      type: 'run.usage',
      inputTokens: 10,
      outputTokens: 9,
      estimated: false,
    });
  });
});

describe('streamTurn', () => {
  async function collect(it: AsyncIterable<AdapterEvent>) {
    const out: AdapterEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('ends a turn on abort even if the body never yields again', async () => {
    const controller = new AbortController();
    let cleanedUp = false;
    const turn = streamTurn({
      signal: controller.signal,
      usage: new UsageTracker(1),
      toAppError: AppError.from,
      body: async function* () {
        try {
          yield { type: 'run.text_delta', text: 'abcd' };
          await never(new AbortController().signal); // an SDK that ignores the signal
          return 'end_turn';
        } finally {
          cleanedUp = true;
        }
      },
    });
    const events: AdapterEvent[] = [];
    for await (const e of turn) {
      events.push(e);
      if (e.type === 'run.text_delta') controller.abort();
    }
    expect(events.slice(1)).toEqual([
      { type: 'run.usage', inputTokens: 1, outputTokens: 1, estimated: true },
      { type: 'run.done', stopReason: 'cancelled' },
    ]);
    // The body's cleanup is queued, not awaited; it never runs if the SDK hangs forever.
    expect(cleanedUp).toBe(false);
  });

  it('maps errors thrown by the body and emits nothing after them', async () => {
    const turn = streamTurn({
      signal: new AbortController().signal,
      usage: new UsageTracker(1),
      toAppError: () => httpError(401, 'nope'),
      body: async function* () {
        yield { type: 'run.text_delta', text: 'a' };
        throw new Error('raw');
      },
    });
    await expect(collect(turn)).rejects.toMatchObject({ code: 'auth_failed' });
  });
});
