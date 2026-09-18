import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterEvent, RunContext, RunInput } from '../src/providers/ProviderAdapter.js';
import { AnthropicAdapter, toProviderMessages } from '../src/providers/api/AnthropicAdapter.js';
import {
  anthropicConnection,
  startFakeAnthropic,
  userText,
  type FakeAnthropic,
} from '../src/testing/index.js';
import { AppError } from '@comitiva/contract';

const ctx: RunContext = {
  tools: [],
  callTool: () => Promise.reject(new Error('no tools')),
  log: () => {},
};

let fake: FakeAnthropic;
const adapter = new AnthropicAdapter();

beforeAll(async () => {
  fake = await startFakeAnthropic({ chunks: 5, intervalMs: 1 });
});
afterAll(() => fake.close());

function input(text: string, secret: string | undefined = 'sk-test'): RunInput {
  return {
    connection: anthropicConnection(fake.url),
    secret,
    model: 'claude-haiku-4-5',
    system: 'Be brief.',
    params: {},
    messages: [userText('c1', text)],
    harnessSessionId: undefined,
  };
}

async function drain(it: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function errorOf(text: string, secret?: string): Promise<AppError> {
  try {
    await drain(adapter.run(input(text, secret), ctx, new AbortController().signal));
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected an error');
}

describe('AnthropicAdapter.run', () => {
  it('streams text deltas, then usage, then done', async () => {
    const events = await drain(adapter.run(input('hello'), ctx, new AbortController().signal));
    const deltas = events.filter((e) => e.type === 'run.text_delta');
    expect(deltas).toHaveLength(5);
    expect(events.at(-2)).toMatchObject({
      type: 'run.usage',
      inputTokens: 2,
      outputTokens: 10,
      estimated: false,
    });
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });
  });

  it('sends the key, model, system prompt and history', async () => {
    await drain(adapter.run(input('check request'), ctx, new AbortController().signal));
    const last = fake.requests.at(-1)!;
    expect(last.apiKey).toBe('sk-test');
    expect(last.body).toMatchObject({
      model: 'claude-haiku-4-5',
      system: 'Be brief.',
      stream: true,
    });
  });

  it('on abort yields partial usage and done(cancelled), and the HTTP request is closed', async () => {
    const controller = new AbortController();
    const abortedBefore = fake.aborted;
    const events: AdapterEvent[] = [];
    for await (const e of adapter.run(
      input('long [chunks:200] [interval:5]'),
      ctx,
      controller.signal,
    )) {
      events.push(e);
      if (events.length === 3) controller.abort();
    }
    expect(events.at(-2)).toMatchObject({ type: 'run.usage' });
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'cancelled' });
    await expect.poll(() => fake.aborted).toBe(abortedBefore + 1);
  });

  it.each([
    [401, 'auth_failed', false],
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
    [529, 'provider_unavailable', true],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const err = await errorOf(`[error:${status}]`);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
  });

  it('requires a secret and never falls back to ambient credentials', async () => {
    expect((await errorOf('hi', '')).code).toBe('secret_missing');
  });
});

describe('AnthropicAdapter.testConnection', () => {
  it('succeeds with a valid key', async () => {
    const r = await adapter.testConnection(anthropicConnection(fake.url), 'sk-test');
    expect(r.ok).toBe(true);
  });

  it('reports auth_failed with a bad key', async () => {
    const r = await adapter.testConnection(anthropicConnection(fake.url), 'bad-key');
    expect(r).toMatchObject({ ok: false, error: { code: 'auth_failed' } });
  });
});

describe('toProviderMessages', () => {
  it('maps canonical tool messages to user turns with tool_result blocks', () => {
    const out = toProviderMessages([
      {
        id: 'm1',
        conversationId: 'c',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            toolServerId: 'fs',
            name: 'fs__read',
            input: { path: 'a' },
          },
        ],
        status: 'complete',
        seq: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        conversationId: 'c',
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu1',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          },
        ],
        status: 'complete',
        seq: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'fs__read', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            is_error: false,
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
      },
    ]);
  });

  it('rejects file-sourced images for now', () => {
    expect(() =>
      toProviderMessages([
        {
          ...userText('c', ''),
          content: [{ type: 'image', source: { kind: 'file', path: '/x.png' } }],
        },
      ]),
    ).toThrow(/file sources/);
  });
});
