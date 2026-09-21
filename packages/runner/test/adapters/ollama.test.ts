import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../../src/providers/api/OllamaAdapter.js';
import { ollamaConnection } from '../../src/testing/index.js';
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

const BASE = 'http://ollama.test';
const adapter = new OllamaAdapter();
const line = (chunk: unknown) => `${JSON.stringify(chunk)}\n`;

const wire: Wire = {
  name: 'OllamaAdapter',
  adapter,
  baseUrl: BASE,
  secret: undefined,
  connection: (baseUrl) => ollamaConnection(baseUrl),
  keyOf: (req) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
  streamRoute: '/api/chat',
  contentType: 'application/x-ndjson',
  frames: (texts, { usage, stop }) => [
    ...texts.map((content) =>
      line({ model: 'm', message: { role: 'assistant', content }, done: false }),
    ),
    line({
      model: 'm',
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: stop === 'length' ? 'length' : 'stop',
      ...(usage ? { prompt_eval_count: usage.input, eval_count: usage.output } : {}),
    }),
  ],
  errorBody: (status) => ({ error: `e${status}` }),
  modelsRoute: '/api/tags',
  modelsBody: {
    models: [
      { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 1 },
      { name: 'qwen3:8b', model: 'qwen3:8b', size: 1 },
    ],
  },
  expectedModels: [{ id: 'llama3.2:latest' }, { id: 'qwen3:8b' }],
  testRoute: '/api/version',
  testBody: { version: '0.12.0' },
  toolCallFrames: (call, usage) => [
    line({
      model: 'm',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: call.name, arguments: call.input } }],
      },
      done: false,
    }),
    line({
      model: 'm',
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: usage.input,
      eval_count: usage.output,
    }),
  ],
  toolNamesIn: (body) =>
    ((body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(
      (t) => t.function.name,
    ),
  toolResultIn: (body, call) =>
    (
      body as { messages: Array<{ role: string; tool_name?: string; content: string }> }
    ).messages.find((m) => m.role === 'tool' && m.tool_name === call.name)?.content,
};

describeAdapterConformance(wire);

describe('OllamaAdapter specifics', () => {
  useMsw();

  it('sends messages, options and a bearer key when one is set', async () => {
    let body: Record<string, unknown> = {};
    let auth: string | null = null;
    server.use(
      http.post(`${BASE}/api/chat`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        auth = request.headers.get('authorization');
        return streamed(
          wire.frames(['ok'], { usage: { input: 1, output: 1 }, stop: 'end' }),
          wire.contentType,
        );
      }),
    );
    const input = {
      ...runInput(ollamaConnection(`${BASE}/`), 'proxy-key'),
      params: { temperature: 0.1, topP: 0.5, maxTokens: 20 },
    };
    await drain(adapter.run(input, ctx, new AbortController().signal));
    expect(body).toEqual({
      model: 'test-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      options: { temperature: 0.1, top_p: 0.5, num_predict: 20 },
    });
    expect(auth).toBe('Bearer proxy-key');
  });

  it('turns an error line in the stream into provider_error', async () => {
    server.use(
      http.post(`${BASE}/api/chat`, () =>
        streamed(
          [line({ message: { content: 'a' }, done: false }), line({ error: 'model crashed' })],
          wire.contentType,
        ),
      ),
    );
    const err = await runError(adapter, runInput(ollamaConnection(BASE), undefined));
    expect({ code: err.code, message: err.message }).toEqual({
      code: 'provider_error',
      message: 'model crashed',
    });
  });

  it('handles a final line without a trailing newline', async () => {
    server.use(
      http.post(`${BASE}/api/chat`, () =>
        streamed(
          [
            line({ message: { content: 'a' }, done: false }),
            JSON.stringify({
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 2,
              eval_count: 1,
            }),
          ],
          wire.contentType,
        ),
      ),
    );
    const events = await drain(
      adapter.run(runInput(ollamaConnection(BASE), undefined), ctx, new AbortController().signal),
    );
    expect(events.slice(-2)).toEqual([
      { type: 'run.usage', inputTokens: 2, outputTokens: 1, estimated: false },
      { type: 'run.done', stopReason: 'end_turn' },
    ]);
  });
});
