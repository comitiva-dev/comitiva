import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/providers/api/OpenAICompatibleAdapter.js';
import { openaiConnection } from '../../src/testing/index.js';
import {
  ctx,
  describeAdapterConformance,
  drain,
  runInput,
  server,
  streamed,
  useMsw,
  type Wire,
} from './conformance.js';

const BASE = 'http://openai.test/v1';
const adapter = new OpenAICompatibleAdapter();
const data = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  data({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices, ...extra });

const wire: Wire = {
  name: 'OpenAICompatibleAdapter',
  adapter,
  baseUrl: BASE,
  secret: 'sk-test',
  connection: (baseUrl) => openaiConnection(baseUrl),
  keyOf: (req) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
  streamRoute: '/chat/completions',
  contentType: 'text/event-stream',
  frames: (texts, { usage, stop }) => [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    ...texts.map((t) => chunk([{ index: 0, delta: { content: t }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: stop === 'length' ? 'length' : 'stop' }]),
    ...(usage
      ? [
          chunk([], {
            usage: {
              prompt_tokens: usage.input,
              completion_tokens: usage.output,
              total_tokens: usage.input + usage.output,
            },
          }),
        ]
      : []),
    'data: [DONE]\n\n',
  ],
  errorBody: (status) => ({ error: { message: `e${status}`, type: 'x', code: null } }),
  modelsRoute: '/models',
  modelsBody: {
    object: 'list',
    data: [
      { id: 'gpt-4o-mini', object: 'model', created: 0, owned_by: 'openai' },
      // OpenRouter
      { id: 'anthropic/claude', object: 'model', name: 'Claude', context_length: 200000 },
      // Groq
      { id: 'llama-3.3-70b', object: 'model', context_window: 131072 },
    ],
  },
  expectedModels: [
    { id: 'gpt-4o-mini' },
    { id: 'anthropic/claude', name: 'Claude', contextWindow: 200000 },
    { id: 'llama-3.3-70b', contextWindow: 131072 },
  ],
  testRoute: '/models',
  testBody: { object: 'list', data: [] },
  toolCallFrames: (call, usage) => [
    chunk([{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }]),
    chunk([
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ]),
    ...JSON.stringify(call.input)
      .match(/.{1,5}/g)!
      .map((args) =>
        chunk([
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
            finish_reason: null,
          },
        ]),
      ),
    chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    chunk([], {
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
      },
    }),
    'data: [DONE]\n\n',
  ],
  toolNamesIn: (body) =>
    ((body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(
      (t) => t.function.name,
    ),
  toolResultIn: (body, call) =>
    (
      body as { messages: Array<{ role: string; tool_call_id?: string; content: string }> }
    ).messages.find((m) => m.role === 'tool' && m.tool_call_id === call.id)?.content,
};

describeAdapterConformance(wire);

describe('OpenAICompatibleAdapter specifics', () => {
  useMsw();

  function capture(): { body: () => Record<string, unknown>; headers: () => Headers } {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        headers = request.headers;
        return streamed(
          wire.frames(['ok'], { usage: { input: 1, output: 1 }, stop: 'end' }),
          'text/event-stream',
        );
      }),
    );
    return { body: () => body, headers: () => headers };
  }

  it('sends the system prompt as a system message, asks for usage and maps params', async () => {
    const c = capture();
    const input = {
      ...runInput(openaiConnection(BASE), 'k'),
      params: { temperature: 0.5, topP: 0.8, maxTokens: 100 },
    };
    await drain(adapter.run(input, ctx, new AbortController().signal));
    expect(c.body()).toMatchObject({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('uses max_completion_tokens for the OpenAI preset', async () => {
    const c = capture();
    const connection = openaiConnection(BASE);
    connection.config.preset = 'openai';
    await drain(
      adapter.run(
        { ...runInput(connection, 'k'), params: { maxTokens: 50 } },
        ctx,
        new AbortController().signal,
      ),
    );
    expect(c.body()).toMatchObject({ max_completion_tokens: 50 });
    expect(c.body()).not.toHaveProperty('max_tokens');
  });

  it('sends no Authorization header without a key (LM Studio, local servers)', async () => {
    const c = capture();
    const events = await drain(
      adapter.run(runInput(openaiConnection(BASE), undefined), ctx, new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });
    expect(c.headers().get('authorization')).toBeNull();
  });

  it('reports cached prompt tokens', async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () =>
        streamed(
          [
            chunk([{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }]),
            chunk([], {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
                prompt_tokens_details: { cached_tokens: 8 },
              },
            }),
            'data: [DONE]\n\n',
          ],
          'text/event-stream',
        ),
      ),
    );
    const events = await drain(
      adapter.run(runInput(openaiConnection(BASE), 'k'), ctx, new AbortController().signal),
    );
    expect(events.at(-2)).toEqual({
      type: 'run.usage',
      // prompt_tokens 10 includes the 8 cached ones; input is reported net,
      // so pricing charges the cache rate for them exactly once.
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 8,
      estimated: false,
      model: 'm',
    });
  });
});
