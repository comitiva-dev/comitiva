import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { GoogleAdapter } from '../../src/providers/api/GoogleAdapter.js';
import { googleConnection } from '../../src/testing/index.js';
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

const BASE = 'http://gemini.test';
const STREAM = /^http:\/\/gemini\.test\/v1beta\/models\/[^/:]+:streamGenerateContent/;
const adapter = new GoogleAdapter();
const data = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\r\n\r\n`;

const wire: Wire = {
  name: 'GoogleAdapter',
  adapter,
  baseUrl: BASE,
  secret: 'AIza-test',
  connection: (baseUrl) => googleConnection(baseUrl),
  keyOf: (req) => req.headers.get('x-goog-api-key'),
  streamRoute: STREAM,
  contentType: 'text/event-stream',
  frames: (texts, { usage, stop }) => [
    ...texts.map((text) =>
      data({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] }),
    ),
    data({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: '' }] },
          finishReason: stop === 'length' ? 'MAX_TOKENS' : 'STOP',
          index: 0,
        },
      ],
      ...(usage
        ? { usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output } }
        : {}),
    }),
  ],
  errorBody: (status) => ({ error: { code: status, message: `e${status}`, status: 'X' } }),
  modelsRoute: '/v1beta/models',
  modelsBody: {
    models: [
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        inputTokenLimit: 1048576,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  },
  expectedModels: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 }],
  testRoute: '/v1beta/models',
  testBody: { models: [] },
};

describeAdapterConformance(wire);

describe('GoogleAdapter specifics', () => {
  useMsw();

  it('sends contents, system instruction and generation config', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(STREAM, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return streamed(
          wire.frames(['ok'], { usage: { input: 1, output: 1 }, stop: 'end' }),
          'text/event-stream',
        );
      }),
    );
    const input = {
      ...runInput(googleConnection(BASE), 'k'),
      params: { temperature: 0.3, topP: 0.7, maxTokens: 64 },
    };
    input.messages.push({
      ...input.messages[0]!,
      role: 'assistant',
      content: [{ type: 'text', text: 'yo' }],
    });
    await drain(adapter.run(input, ctx, new AbortController().signal));
    expect(body).toMatchObject({
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'yo' }] },
      ],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { temperature: 0.3, topP: 0.7, maxOutputTokens: 64 },
    });
  });

  it('counts thinking tokens as output and skips thought parts', async () => {
    server.use(
      http.post(STREAM, () =>
        streamed(
          [
            data({
              candidates: [{ content: { role: 'model', parts: [{ text: 'hmm', thought: true }] } }],
            }),
            data({
              candidates: [
                { content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' },
              ],
              usageMetadata: {
                promptTokenCount: 4,
                candidatesTokenCount: 2,
                thoughtsTokenCount: 30,
                cachedContentTokenCount: 1,
              },
            }),
          ],
          'text/event-stream',
        ),
      ),
    );
    const events = await drain(
      adapter.run(runInput(googleConnection(BASE), 'k'), ctx, new AbortController().signal),
    );
    expect(events.filter((e) => e.type === 'run.text_delta')).toEqual([
      { type: 'run.text_delta', text: 'answer' },
    ]);
    expect(events.at(-2)).toEqual({
      type: 'run.usage',
      inputTokens: 4,
      outputTokens: 32,
      cacheReadTokens: 1,
      estimated: false,
    });
  });

  it('maps safety stops to refusal', async () => {
    server.use(
      http.post(STREAM, () =>
        streamed(
          [
            data({
              candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }],
            }),
          ],
          'text/event-stream',
        ),
      ),
    );
    const events = await drain(
      adapter.run(runInput(googleConnection(BASE), 'k'), ctx, new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'refusal' });
  });

  it('maps an invalid key (400 API_KEY_INVALID) to auth_failed', async () => {
    server.use(
      http.get(`${BASE}/v1beta/models`, () =>
        HttpResponse.json(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ reason: 'API_KEY_INVALID' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    expect(await adapter.testConnection(googleConnection(BASE), 'bad')).toMatchObject({
      ok: false,
      error: { code: 'auth_failed', retryable: false },
    });
  });

  it('requires a key', async () => {
    expect((await runError(adapter, runInput(googleConnection(BASE), undefined))).code).toBe(
      'secret_missing',
    );
  });
});
