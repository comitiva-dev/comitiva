import { createServer } from 'node:net';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type Connection, type ModelInfo } from '@comitiva/contract';
import type {
  AdapterEvent,
  ProviderAdapter,
  RunContext,
  RunInput,
} from '../../src/providers/ProviderAdapter.js';
import { userText } from '../../src/testing/index.js';
import { countText } from '../../src/usage/Tokenizer.js';

/**
 * Conformance suite every API adapter runs against msw: streaming order,
 * usage (reported and estimated), stop reasons, cancel, error mapping,
 * listModels, testConnection and never reading ambient env credentials.
 * A new adapter describes its wire format in a `Wire` and calls
 * `describeAdapterConformance`. See docs/providers.md.
 */

export interface Wire {
  name: string;
  adapter: ProviderAdapter;
  /** Base URL msw intercepts (any host; nothing leaves the process). */
  baseUrl: string;
  secret: string | undefined;
  connection(baseUrl: string): Connection;
  /** The credential a request carries, however the provider sends it. */
  keyOf(request: Request): string | null;
  /** Streaming endpoint (string path relative to base, or a RegExp on the URL). */
  streamRoute: string | RegExp;
  contentType: string;
  /** Wire frames for a streamed answer made of `texts`. */
  frames(
    texts: string[],
    opts: { usage: { input: number; output: number } | null; stop: 'end' | 'length' },
  ): string[];
  errorBody(status: number): unknown;
  modelsRoute: string;
  modelsBody: unknown;
  expectedModels: ModelInfo[];
  /** Route `testConnection` calls (answered with `testBody`). */
  testRoute: string;
  testBody: unknown;
  /** Wire frames for an answer that calls one tool (and reports `usage`). */
  toolCallFrames(
    call: { id: string; name: string; input: unknown },
    usage: { input: number; output: number },
  ): string[];
  /** Tool names a request body offers the model. */
  toolNamesIn(body: unknown): string[];
  /** The text a request body sends back as the result of tool call `id` (name for Gemini). */
  toolResultIn(body: unknown, call: { id: string; name: string }): string | undefined;
}

export const server = setupServer();

export const ctx: RunContext = {
  tools: [],
  toolServerId: () => '',
  callTool: () => Promise.reject(new Error('no tools')),
  log: () => {},
};

export function runInput(
  connection: Connection,
  secret: string | undefined,
  text = 'hi',
): RunInput {
  return {
    connection,
    secret,
    model: 'test-model',
    system: 'Be brief.',
    params: {},
    messages: [userText('c1', text)],
    harnessSessionId: undefined,
  };
}

export async function drain(it: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export async function runError(adapter: ProviderAdapter, input: RunInput): Promise<AppError> {
  try {
    await drain(adapter.run(input, ctx, new AbortController().signal));
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the run to fail');
}

/** A response whose body sends `frames` one by one, `intervalMs` apart. */
export function streamed(
  frames: string[],
  contentType: string,
  intervalMs = 1,
  onCancel?: () => void,
): HttpResponse<ReadableStream> {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        if (cancelled) return;
        controller.enqueue(encoder.encode(frame));
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      onCancel?.();
    },
  });
  return new HttpResponse(body, { headers: { 'content-type': contentType } });
}

/** A local URL where nothing listens: a real refused connection. */
async function refusedUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** Starts msw for a test file; real sockets are allowed only to 127.0.0.1. */
export function useMsw(): void {
  beforeAll(() =>
    server.listen({
      onUnhandledRequest: (req, print) => {
        if (new URL(req.url).hostname !== '127.0.0.1') print.error();
      },
    }),
  );
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

const TEXTS = ['Hel', 'lo ', 'wor', 'ld'];

export function describeAdapterConformance(w: Wire): void {
  const route = (r: string | RegExp) => (typeof r === 'string' ? `${w.baseUrl}${r}` : r);
  const conn = () => w.connection(w.baseUrl);

  function mountStream(
    frames: string[],
    opts: { intervalMs?: number; onRequest?: (req: Request) => void; onCancel?: () => void } = {},
  ): RequestHandler {
    const handler = http.post(route(w.streamRoute), ({ request }) => {
      opts.onRequest?.(request);
      return streamed(frames, w.contentType, opts.intervalMs, opts.onCancel);
    });
    server.use(handler);
    return handler;
  }

  function mountError(status: number): void {
    server.use(
      http.all(`${w.baseUrl}/*`, () =>
        HttpResponse.json(w.errorBody(status) as never, {
          status,
          headers: { 'x-should-retry': 'false' },
        }),
      ),
      ...(w.streamRoute instanceof RegExp
        ? [
            http.post(w.streamRoute, () =>
              HttpResponse.json(w.errorBody(status) as never, {
                status,
                headers: { 'x-should-retry': 'false' },
              }),
            ),
          ]
        : []),
    );
  }

  describe(`${w.name} conformance`, () => {
    useMsw();

    it('declares its id and API kind', () => {
      expect(w.adapter.kind).toBe('api');
      expect(w.connection(w.baseUrl).provider).toBe(w.adapter.id);
      expect(w.adapter.capabilities.streaming).toBe(true);
      expect(w.adapter.capabilities.listModels).toBe(true);
    });

    it('streams deltas in order, then the reported usage, then done(end_turn)', async () => {
      let key: string | null = null;
      mountStream(w.frames(TEXTS, { usage: { input: 11, output: 7 }, stop: 'end' }), {
        onRequest: (req) => (key = w.keyOf(req)),
      });
      const events = await drain(
        w.adapter.run(runInput(conn(), w.secret), ctx, new AbortController().signal),
      );
      expect(events.filter((e) => e.type === 'run.text_delta').map((e) => e.text)).toEqual(TEXTS);
      expect(events.at(-2)).toMatchObject({
        type: 'run.usage',
        inputTokens: 11,
        outputTokens: 7,
        estimated: false,
      });
      expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });
      expect(events.filter((e) => e.type === 'run.usage')).toHaveLength(1);
      expect(key).toBe(w.secret ?? null);
    });

    it('estimates usage when the provider reports none', async () => {
      mountStream(w.frames(TEXTS, { usage: null, stop: 'end' }));
      const events = await drain(
        w.adapter.run(
          runInput(conn(), w.secret, 'x'.repeat(40)),
          ctx,
          new AbortController().signal,
        ),
      );
      const usage = events.find((e) => e.type === 'run.usage');
      // The count is a local approximation, so assert the shape and the
      // neighbourhood, not a number that moves whenever the tokenizer improves.
      expect(usage).toMatchObject({ estimated: true });
      const out = usage && 'outputTokens' in usage ? usage.outputTokens : 0;
      const input = usage && 'inputTokens' in usage ? usage.inputTokens : 0;
      expect(out).toBeGreaterThan(0);
      expect(out).toBeLessThanOrEqual(countText(TEXTS.join('')));
      // The 40-character prompt has to weigh more than the 11 streamed chars.
      expect(input).toBeGreaterThan(out);
    });

    it('maps the length stop to max_tokens', async () => {
      mountStream(w.frames(TEXTS, { usage: { input: 1, output: 2 }, stop: 'length' }));
      const events = await drain(
        w.adapter.run(runInput(conn(), w.secret), ctx, new AbortController().signal),
      );
      expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'max_tokens' });
    });

    it('on abort yields estimated usage and done(cancelled), and closes the request', async () => {
      const texts = Array.from({ length: 200 }, (_, i) => `chunk ${i} `);
      let closed = false;
      mountStream(w.frames(texts, { usage: { input: 3, output: 400 }, stop: 'end' }), {
        intervalMs: 5,
        onRequest: (req) => req.signal.addEventListener('abort', () => (closed = true)),
        onCancel: () => (closed = true),
      });
      const controller = new AbortController();
      const events: AdapterEvent[] = [];
      for await (const e of w.adapter.run(runInput(conn(), w.secret), ctx, controller.signal)) {
        events.push(e);
        if (events.length === 3) controller.abort();
      }
      const deltas = events.filter((e) => e.type === 'run.text_delta');
      expect(deltas.length).toBeLessThan(200);
      expect(events.at(-2)).toMatchObject({ type: 'run.usage', estimated: true });
      expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'cancelled' });
      expect(events.filter((e) => e.type === 'run.done' || e.type === 'run.usage')).toHaveLength(2);
      await expect.poll(() => closed).toBe(true);
    });

    it.each([
      [401, 'auth_failed', false],
      [403, 'auth_failed', false],
      [429, 'rate_limited', true],
      [500, 'provider_unavailable', true],
      [503, 'provider_unavailable', true],
      [404, 'provider_error', false],
    ] as const)('maps HTTP %i to %s (retryable: %s)', async (status, code, retryable) => {
      mountError(status);
      const err = await runError(w.adapter, runInput(conn(), w.secret));
      expect(err).toBeInstanceOf(AppError);
      expect({ code: err.code, retryable: err.retryable }).toEqual({ code, retryable });

      const test = await w.adapter.testConnection(conn(), w.secret);
      expect(test).toMatchObject({ ok: false, error: { code, retryable } });
      await expect(w.adapter.listModels!(conn(), w.secret)).rejects.toMatchObject({ code });
    });

    it('still reports the usage of a run that fails', async () => {
      // Tokens spent before the failure are billed by the provider, so the
      // shell has to hear about them or the record is silently short.
      mountError(500);
      const events: AdapterEvent[] = [];
      await expect(
        (async () => {
          for await (const e of w.adapter.run(
            runInput(conn(), w.secret, 'x'.repeat(200)),
            ctx,
            new AbortController().signal,
          )) {
            events.push(e);
          }
        })(),
      ).rejects.toBeInstanceOf(AppError);
      const usage = events.filter((e) => e.type === 'run.usage');
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ estimated: true });
      expect(usage[0] && 'inputTokens' in usage[0] && usage[0].inputTokens).toBeGreaterThan(0);
      // A failure is still not a `run.done`; the Run turns it into run.error.
      expect(events.filter((e) => e.type === 'run.done')).toHaveLength(0);
    });

    it('maps a refused connection to provider_unavailable (retryable)', async () => {
      const connection = w.connection(await refusedUrl());
      const test = await w.adapter.testConnection(connection, w.secret);
      expect(test).toMatchObject({
        ok: false,
        error: { code: 'provider_unavailable', retryable: true },
      });
      await expect(w.adapter.listModels!(connection, w.secret)).rejects.toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
      });
      const err = await runError(w.adapter, runInput(connection, w.secret));
      expect({ code: err.code, retryable: err.retryable }).toEqual({
        code: 'provider_unavailable',
        retryable: true,
      });
    });

    it('runs the tool loop: tool call → ctx.callTool → result sent back → answer', async () => {
      const bodies: unknown[] = [];
      server.use(
        http.post(route(w.streamRoute), async ({ request }) => {
          bodies.push(await request.json());
          const frames =
            bodies.length === 1
              ? w.toolCallFrames(
                  { id: 'call_1', name: 'fs__read_file', input: { path: 'a.txt' } },
                  { input: 11, output: 7 },
                )
              : w.frames(['Done'], { usage: { input: 13, output: 2 }, stop: 'end' });
          return streamed(frames, w.contentType);
        }),
      );
      const calls: Array<{ id: string; name: string; input: unknown }> = [];
      const toolCtx: RunContext = {
        ...ctx,
        tools: [
          {
            name: 'fs__read_file',
            description: 'Reads a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        toolServerId: (name) => (name === 'fs__read_file' ? 'filesystem' : ''),
        callTool: (id, name, input) => {
          calls.push({ id, name, input });
          return Promise.resolve({
            content: [{ type: 'text', text: 'file body' }],
            isError: false,
          });
        },
      };
      const events = await drain(
        w.adapter.run(runInput(conn(), w.secret), toolCtx, new AbortController().signal),
      );
      expect(calls).toEqual([
        { id: expect.any(String), name: 'fs__read_file', input: { path: 'a.txt' } },
      ]);
      const block = events.find((e) => e.type === 'run.block');
      expect(block).toMatchObject({
        block: {
          type: 'tool_use',
          id: calls[0]!.id,
          toolServerId: 'filesystem',
          name: 'fs__read_file',
          input: { path: 'a.txt' },
        },
      });
      expect(bodies).toHaveLength(2);
      expect(w.toolNamesIn(bodies[0])).toEqual(['fs__read_file']);
      expect(w.toolResultIn(bodies[1], { id: calls[0]!.id, name: 'fs__read_file' })).toBe(
        'file body',
      );
      expect(events.filter((e) => e.type === 'run.text_delta').map((e) => e.text)).toEqual([
        'Done',
      ]);
      expect(events.at(-2)).toMatchObject({
        type: 'run.usage',
        inputTokens: 24,
        outputTokens: 9,
        estimated: false,
      });
      expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });
    });

    it('lists models', async () => {
      server.use(http.get(route(w.modelsRoute), () => HttpResponse.json(w.modelsBody as never)));
      expect(await w.adapter.listModels!(conn(), w.secret)).toEqual(w.expectedModels);
    });

    it('tests the connection and reports latency', async () => {
      let key: string | null = null;
      server.use(
        http.get(route(w.testRoute), ({ request }) => {
          key = w.keyOf(request);
          return HttpResponse.json(w.testBody as never);
        }),
      );
      const result = await w.adapter.testConnection(conn(), w.secret);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(key).toBe(w.secret ?? null);
    });

    it('never uses ambient credentials or endpoints from the environment', async () => {
      const saved = { ...process.env };
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: 'env-key',
        ANTHROPIC_AUTH_TOKEN: 'env-token',
        ANTHROPIC_BASE_URL: 'http://env.invalid',
        OPENAI_API_KEY: 'env-key',
        OPENAI_BASE_URL: 'http://env.invalid',
        GEMINI_API_KEY: 'env-key',
        GOOGLE_API_KEY: 'env-key',
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
      });
      try {
        let key: string | null = 'not called';
        server.use(
          http.get(route(w.testRoute), ({ request }) => {
            key = w.keyOf(request);
            return HttpResponse.json(w.testBody as never);
          }),
        );
        expect(await w.adapter.testConnection(conn(), w.secret)).toMatchObject({ ok: true });
        expect(key).toBe(w.secret ?? null);
      } finally {
        process.env = saved;
      }
    });
  });
}
