import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, toProviderMessages } from '../../src/providers/api/AnthropicAdapter.js';
import { anthropicConnection, userText } from '../../src/testing/index.js';
import {
  ctx,
  describeAdapterConformance,
  drain,
  runError,
  runInput,
  server,
  streamed,
  useMsw,
  type Wire,
} from './conformance.js';

const BASE = 'http://anthropic.test';
const adapter = new AnthropicAdapter();
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const wire: Wire = {
  name: 'AnthropicAdapter',
  adapter,
  baseUrl: BASE,
  secret: 'sk-ant-test',
  connection: (baseUrl) => anthropicConnection(baseUrl),
  keyOf: (req) => req.headers.get('x-api-key'),
  streamRoute: '/v1/messages',
  contentType: 'text/event-stream',
  frames: (texts, { usage, stop }) => [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage?.input ?? 5,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...texts.map((text) =>
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
    ),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    // Without usage: the stream ends before the final message_delta.
    ...(usage
      ? [
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stop === 'length' ? 'max_tokens' : 'end_turn' },
            usage: { output_tokens: usage.output },
          }),
        ]
      : []),
    sse('message_stop', { type: 'message_stop' }),
  ],
  errorBody: (status) => ({
    type: 'error',
    error: { type: status === 401 ? 'authentication_error' : 'api_error', message: `e${status}` },
  }),
  modelsRoute: '/v1/models',
  modelsBody: {
    data: [
      {
        type: 'model',
        id: 'claude-haiku-4-5',
        display_name: 'Claude Haiku 4.5',
        created_at: '2025-10-01T00:00:00Z',
        max_input_tokens: 200000,
      },
      {
        type: 'model',
        id: 'claude-old',
        display_name: 'Old',
        created_at: '2024-01-01T00:00:00Z',
      },
    ],
    has_more: false,
    first_id: 'claude-haiku-4-5',
    last_id: 'claude-old',
  },
  expectedModels: [
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000 },
    { id: 'claude-old', name: 'Old' },
  ],
  toolCallFrames: (call, usage) => [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    }),
    ...JSON.stringify(call.input)
      .match(/.{1,5}/g)!
      .map((partial_json) =>
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json },
        }),
      ),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: usage.output },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ],
  toolNamesIn: (body) =>
    ((body as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name),
  toolResultIn: (body, call) => {
    const messages = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result' && b.tool_use_id === call.id) {
          return (b.content as Array<{ text: string }>).map((c) => c.text).join('');
        }
      }
    }
    return undefined;
  },
  testRoute: '/v1/models',
  testBody: { data: [], has_more: false, first_id: null, last_id: null },
};

describeAdapterConformance(wire);

describe('AnthropicAdapter specifics', () => {
  useMsw();

  it('sends model, system prompt, params and a default max_tokens', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/v1/messages`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return streamed(
          wire.frames(['ok'], { usage: { input: 1, output: 1 }, stop: 'end' }),
          'text/event-stream',
        );
      }),
    );
    const input = {
      ...runInput(anthropicConnection(BASE), 'k'),
      params: { temperature: 0.2, topP: 0.9 },
    };
    await drain(adapter.run(input, ctx, new AbortController().signal));
    expect(body).toMatchObject({
      model: 'test-model',
      system: 'Be brief.',
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('reports cache tokens', async () => {
    server.use(
      http.post(`${BASE}/v1/messages`, () =>
        streamed(
          [
            sse('message_start', {
              type: 'message_start',
              message: {
                id: 'm',
                type: 'message',
                role: 'assistant',
                model: 'x',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 5,
                  output_tokens: 1,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 7,
                },
              },
            }),
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 3 },
            }),
            sse('message_stop', { type: 'message_stop' }),
          ],
          'text/event-stream',
        ),
      ),
    );
    const events = await drain(
      adapter.run(runInput(anthropicConnection(BASE), 'k'), ctx, new AbortController().signal),
    );
    expect(events.at(-2)).toEqual({
      type: 'run.usage',
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 100,
      cacheWriteTokens: 7,
      estimated: false,
    });
  });

  it('requires a key', async () => {
    expect((await runError(adapter, runInput(anthropicConnection(BASE), undefined))).code).toBe(
      'secret_missing',
    );
    expect(await adapter.testConnection(anthropicConnection(BASE))).toMatchObject({
      ok: false,
      error: { code: 'secret_missing' },
    });
  });
});

describe('toProviderMessages', () => {
  it('maps canonical tool messages to user turns with tool_result blocks', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const out = toProviderMessages([
      {
        id: 'm1',
        conversationId: 'c',
        role: 'assistant',
        status: 'complete',
        error: null,
        seq: 1,
        createdAt: at,
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            toolServerId: 'fs',
            name: 'fs__read',
            input: { path: 'a' },
          },
        ],
      },
      {
        id: 'm2',
        conversationId: 'c',
        role: 'tool',
        status: 'complete',
        error: null,
        seq: 2,
        createdAt: at,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu1',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          },
        ],
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
