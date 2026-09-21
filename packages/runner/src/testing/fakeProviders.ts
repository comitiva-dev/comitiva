import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One local HTTP server that fakes the four API providers, for runner
 * integration tests and the desktop e2e (msw cannot reach another process).
 *
 * | provider           | base URL to configure | routes                                               |
 * |--------------------|-----------------------|------------------------------------------------------|
 * | anthropic          | `urls.anthropic`      | GET /v1/models, POST /v1/messages (SSE)              |
 * | openai-compatible  | `urls.openai`         | GET /models, POST /chat/completions (SSE)            |
 * | google             | `urls.google`         | GET /v1beta/models, POST …:streamGenerateContent     |
 * | ollama             | `urls.ollama`         | GET /api/version, GET /api/tags, POST /api/chat      |
 *
 * Behavior is controlled from the last user message:
 * - `[error:N]` → that HTTP error, in the provider's error format
 * - `[chunks:N]` → stream N text deltas `chunk i ` (default `chunks`)
 * - `[interval:MS]` → delay between deltas (default `intervalMs`)
 * - `[tool:NAME {json}]` (repeatable) → the model calls these tools, one per
 *   response, in order; once every call has a result it answers
 *   `Result: <last tool result>` followed by the usual chunks
 * The key `bad-key` is rejected as the real provider would (401; Gemini: 400
 * API_KEY_INVALID). Errors carry `x-should-retry: false` so SDKs do not retry.
 */
export interface FakeProvidersOptions {
  chunks?: number;
  intervalMs?: number;
}

export type FakeProviderId = 'anthropic' | 'openai' | 'google' | 'ollama';

export interface FakeRequest {
  provider: FakeProviderId;
  path: string;
  /** The credential the client sent (x-api-key, bearer token or x-goog-api-key). */
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeProviders {
  url: string;
  urls: Record<FakeProviderId, string>;
  /** Streams whose client disconnected before they finished. */
  readonly aborted: number;
  /** Every request received, in order. */
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

interface State {
  aborted: number;
  requests: FakeRequest[];
}

const PREFIX: Record<Exclude<FakeProviderId, 'anthropic'>, string> = {
  openai: '/openai/v1',
  google: '/gemini',
  ollama: '/ollama',
};

export async function startFakeProviders(opts: FakeProvidersOptions = {}): Promise<FakeProviders> {
  const state: State = { aborted: 0, requests: [] };
  const server: Server = createServer((req, res) => {
    void handle(req, res, opts, state).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    urls: {
      anthropic: url,
      openai: `${url}${PREFIX.openai}`,
      google: `${url}${PREFIX.google}`,
      ollama: `${url}${PREFIX.ollama}`,
    },
    get aborted() {
      return state.aborted;
    },
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ----------------------------------------------------------------- routing

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: FakeProvidersOptions,
  state: State,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = req.method === 'POST' ? await readBody(req) : '';
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

  for (const [provider, prefix] of Object.entries(PREFIX) as Array<
    [Exclude<FakeProviderId, 'anthropic'>, string]
  >) {
    if (url.pathname.startsWith(`${prefix}/`)) {
      const path = url.pathname.slice(prefix.length);
      const ctx = context(provider, path, req, body, opts, state, res);
      state.requests.push({ provider, path, apiKey: ctx.apiKey, body });
      if (provider === 'openai') return openai(ctx, req.method ?? 'GET');
      if (provider === 'google') return google(ctx, req.method ?? 'GET');
      return ollama(ctx, req.method ?? 'GET');
    }
  }
  const ctx = context('anthropic', url.pathname, req, body, opts, state, res);
  state.requests.push({ provider: 'anthropic', path: url.pathname, apiKey: ctx.apiKey, body });
  return anthropic(ctx, req.method ?? 'GET');
}

interface ToolCallScript {
  name: string;
  input: unknown;
}

interface Ctx {
  provider: FakeProviderId;
  path: string;
  apiKey: string | undefined;
  body: Record<string, unknown>;
  prompt: string;
  /** The scripted tool call to make now, if any (with its sequence number). */
  toolCall: (ToolCallScript & { n: number }) | null;
  /** The text of the last tool result the client sent back, if any. */
  lastResult: string | null;
  chunks: number;
  intervalMs: number;
  error: number | null;
  res: ServerResponse;
  state: State;
}

function context(
  provider: FakeProviderId,
  path: string,
  req: IncomingMessage,
  body: Record<string, unknown>,
  opts: FakeProvidersOptions,
  state: State,
  res: ServerResponse,
): Ctx {
  const bearer = header(req, 'authorization')?.replace(/^Bearer\s+/i, '');
  const apiKey =
    provider === 'anthropic'
      ? header(req, 'x-api-key')
      : provider === 'google'
        ? header(req, 'x-goog-api-key')
        : bearer;
  const prompt = lastUserText(provider, body);
  const error = /\[error:(\d{3})\]/.exec(prompt);
  const script = parseToolScript(prompt);
  const results = toolResultsSinceUser(provider, body);
  const next = script[results.length];
  return {
    provider,
    path,
    apiKey,
    body,
    prompt,
    toolCall: next ? { ...next, n: results.length } : null,
    lastResult: results.at(-1) ?? null,
    chunks: Number(/\[chunks:(\d+)\]/.exec(prompt)?.[1] ?? opts.chunks ?? 20),
    intervalMs: Number(/\[interval:(\d+)\]/.exec(prompt)?.[1] ?? opts.intervalMs ?? 10),
    error: apiKey === 'bad-key' ? 401 : error ? Number(error[1]) : null,
    res,
    state,
  };
}

// ---------------------------------------------------------------- anthropic

const ANTHROPIC_ERRORS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

async function anthropic(ctx: Ctx, method: string): Promise<void> {
  const { res } = ctx;
  if (ctx.error) {
    return sendJson(res, ctx.error, {
      type: 'error',
      error: { type: ANTHROPIC_ERRORS[ctx.error] ?? 'api_error', message: `fake ${ctx.error}` },
    });
  }
  if (method === 'GET' && ctx.path === '/v1/models') {
    const data = [
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000 },
      { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', max_input_tokens: 200_000 },
    ].map((m) => ({ type: 'model', created_at: '2025-10-01T00:00:00Z', ...m }));
    return sendJson(res, 200, {
      data,
      has_more: false,
      first_id: data[0]!.id,
      last_id: data.at(-1)!.id,
    });
  }
  if (method !== 'POST' || ctx.path !== '/v1/messages') return sendJson(res, 404, {});

  const model = typeof ctx.body.model === 'string' ? ctx.body.model : 'claude-haiku-4-5';
  const stream = openStream(ctx, 'text/event-stream');
  const send = (event: string, data: unknown) =>
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg_fake_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens(ctx),
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  if (ctx.toolCall) {
    const call = ctx.toolCall;
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_fake_${call.n}`, name: call.name, input: {} },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    send('message_stop', { type: 'message_stop' });
    return stream.end();
  }
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  const done = await streamChunks(ctx, stream, (text) =>
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
  );
  if (!done) return;
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens(ctx) },
  });
  send('message_stop', { type: 'message_stop' });
  stream.end();
}

// ------------------------------------------------------------------- openai

async function openai(ctx: Ctx, method: string): Promise<void> {
  const { res } = ctx;
  if (ctx.error) {
    return sendJson(res, ctx.error, {
      error: { message: `fake ${ctx.error}`, type: 'fake_error', code: null },
    });
  }
  if (method === 'GET' && ctx.path === '/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'gpt-fake-mini', object: 'model', created: 0, owned_by: 'fake' },
        // OpenRouter-style extras
        {
          id: 'vendor/fake-large',
          object: 'model',
          created: 0,
          owned_by: 'fake',
          name: 'Fake Large',
          context_length: 128_000,
        },
      ],
    });
  }
  if (method !== 'POST' || ctx.path !== '/chat/completions') return sendJson(res, 404, {});

  const model = typeof ctx.body.model === 'string' ? ctx.body.model : 'gpt-fake-mini';
  const id = `chatcmpl-fake-${Date.now()}`;
  const stream = openStream(ctx, 'text/event-stream');
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    stream.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices, ...extra })}\n\n`,
    );
  chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  let finish = 'stop';
  if (ctx.toolCall) {
    const call = ctx.toolCall;
    finish = 'tool_calls';
    chunk([
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `call_fake_${call.n}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            },
          ],
        },
        finish_reason: null,
      },
    ]);
  } else {
    const done = await streamChunks(ctx, stream, (text) =>
      chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    );
    if (!done) return;
  }
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  const includeUsage =
    (ctx.body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
  if (includeUsage) {
    const prompt_tokens = inputTokens(ctx);
    const completion_tokens = outputTokens(ctx);
    chunk([], {
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
  }
  stream.write('data: [DONE]\n\n');
  stream.end();
}

// ------------------------------------------------------------------- google

const GOOGLE_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  403: 'PERMISSION_DENIED',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

async function google(ctx: Ctx, method: string): Promise<void> {
  const { res } = ctx;
  if (ctx.apiKey === 'bad-key') {
    // What Gemini really answers for an invalid key.
    return sendJson(res, 400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ reason: 'API_KEY_INVALID' }],
      },
    });
  }
  if (ctx.error) {
    return sendJson(res, ctx.error, {
      error: {
        code: ctx.error,
        message: `fake ${ctx.error}`,
        status: GOOGLE_STATUS[ctx.error] ?? 'UNKNOWN',
      },
    });
  }
  if (method === 'GET' && ctx.path === '/v1beta/models') {
    return sendJson(res, 200, {
      models: [
        {
          name: 'models/gemini-fake-flash',
          displayName: 'Gemini Fake Flash',
          inputTokenLimit: 1_048_576,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/fake-embedding',
          displayName: 'Fake Embedding',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    });
  }
  const match = /^\/v1beta\/models\/([^:]+):streamGenerateContent$/.exec(ctx.path);
  if (method !== 'POST' || !match) return sendJson(res, 404, {});

  const stream = openStream(ctx, 'text/event-stream');
  const prompt = inputTokens(ctx);
  let sent = 0;
  const chunk = (data: unknown) => stream.write(`data: ${JSON.stringify(data)}\r\n\r\n`);
  if (ctx.toolCall) {
    chunk({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: ctx.toolCall.name, args: ctx.toolCall.input } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 5 },
    });
    return stream.end();
  }
  const done = await streamChunks(ctx, stream, (text) => {
    sent++;
    chunk({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
      usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: sent * 2 },
      modelVersion: match[1],
    });
  });
  if (!done) return;
  chunk({
    candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: outputTokens(ctx),
      totalTokenCount: prompt + outputTokens(ctx),
    },
    modelVersion: match[1],
  });
  stream.end();
}

// ------------------------------------------------------------------- ollama

async function ollama(ctx: Ctx, method: string): Promise<void> {
  const { res } = ctx;
  if (ctx.error) return sendJson(res, ctx.error, { error: `fake ${ctx.error}` });
  if (method === 'GET' && ctx.path === '/api/version') {
    return sendJson(res, 200, { version: '0.0.0-fake' });
  }
  if (method === 'GET' && ctx.path === '/api/tags') {
    return sendJson(res, 200, {
      models: [
        { name: 'llama-fake:latest', model: 'llama-fake:latest', size: 1 },
        { name: 'qwen-fake:7b', model: 'qwen-fake:7b', size: 1 },
      ],
    });
  }
  if (method !== 'POST' || ctx.path !== '/api/chat') return sendJson(res, 404, {});

  const model = typeof ctx.body.model === 'string' ? ctx.body.model : 'llama-fake:latest';
  const stream = openStream(ctx, 'application/x-ndjson');
  const line = (data: unknown) => stream.write(`${JSON.stringify(data)}\n`);
  if (ctx.toolCall) {
    line({
      model,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: ctx.toolCall.name, arguments: ctx.toolCall.input } }],
      },
      done: false,
    });
    line({
      model,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: inputTokens(ctx),
      eval_count: 5,
    });
    return stream.end();
  }
  const done = await streamChunks(ctx, stream, (text) =>
    line({ model, message: { role: 'assistant', content: text }, done: false }),
  );
  if (!done) return;
  line({
    model,
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: inputTokens(ctx),
    eval_count: outputTokens(ctx),
  });
  stream.end();
}

// ------------------------------------------------------------------ helpers

const inputTokens = (ctx: Ctx) => Math.max(1, Math.ceil(ctx.prompt.length / 4));
const outputTokens = (ctx: Ctx) => ctx.chunks * 2;

interface Stream {
  write(data: string): void;
  end(): void;
  readonly closed: boolean;
}

function openStream(ctx: Ctx, contentType: string): Stream {
  const { res, state } = ctx;
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      state.aborted++;
    }
  });
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  return {
    write: (data) => void res.write(data),
    end: () => res.end(),
    get closed() {
      return closed;
    },
  };
}

/** Streams `chunks` deltas; false when the client went away first. */
async function streamChunks(
  ctx: Ctx,
  stream: Stream,
  send: (text: string) => void,
): Promise<boolean> {
  if (ctx.lastResult !== null) send(`Result: ${ctx.lastResult.slice(0, 500)}\n`);
  for (let i = 0; i < ctx.chunks; i++) {
    if (stream.closed) return false;
    send(`chunk ${i} `);
    await sleep(ctx.intervalMs);
  }
  return !stream.closed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

type WireMessage = {
  role: string;
  content?: unknown;
  parts?: Array<Record<string, unknown>>;
};

function wireMessages(provider: FakeProviderId, body: Record<string, unknown>): WireMessage[] {
  return (
    ((provider === 'google' ? body.contents : body.messages) as WireMessage[] | undefined) ?? []
  );
}

/** Text a message carries (tool results are not text). */
function textOf(m: WireMessage): string {
  if (m.parts) return m.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** The last user text, whatever the provider's message format (tool results are skipped). */
function lastUserText(provider: FakeProviderId, body: Record<string, unknown>): string {
  const last = [...wireMessages(provider, body)]
    .reverse()
    .find((m) => m.role === 'user' && textOf(m).trim() !== '');
  return last ? textOf(last) : '';
}

/** Texts of the tool results sent after the last user text, in order. */
function toolResultsSinceUser(provider: FakeProviderId, body: Record<string, unknown>): string[] {
  const list = wireMessages(provider, body);
  let start = 0;
  list.forEach((m, i) => {
    if (m.role === 'user' && textOf(m).trim() !== '') start = i + 1;
  });
  const out: string[] = [];
  for (const m of list.slice(start)) {
    if (m.role === 'tool' && typeof m.content === 'string') out.push(m.content);
    for (const p of m.parts ?? []) {
      const r = p.functionResponse as
        { response?: { output?: string; error?: string } } | undefined;
      if (r) out.push(r.response?.output ?? r.response?.error ?? '');
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type: string; content?: unknown }>) {
        if (b.type !== 'tool_result') continue;
        out.push(
          typeof b.content === 'string'
            ? b.content
            : ((b.content as Array<{ text?: string }> | undefined) ?? [])
                .map((c) => c.text ?? '')
                .join(''),
        );
      }
    }
  }
  return out;
}

/** `[tool:NAME {json}]` controls, in order (the JSON may contain brackets). */
export function parseToolScript(prompt: string): ToolCallScript[] {
  const out: ToolCallScript[] = [];
  const re = /\[tool:([A-Za-z0-9_-]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    let i = re.lastIndex;
    let input: unknown = {};
    if (prompt[i] === '{') {
      let depth = 0;
      let inString = false;
      const begin = i;
      for (; i < prompt.length; i++) {
        const c = prompt[i];
        if (inString) {
          if (c === '\\') i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          i++;
          break;
        }
      }
      input = JSON.parse(prompt.slice(begin, i)) as unknown;
    }
    out.push({ name: m[1]!, input });
    re.lastIndex = i;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
