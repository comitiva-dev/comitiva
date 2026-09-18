import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal fake of the Anthropic Messages API for tests and the e2e spike:
 * `POST /v1/messages` (streaming only) and `GET /v1/models`.
 *
 * Behavior is controlled from the last user message:
 * - `[error:401]`, `[error:429]`, `[error:500]`, `[error:529]` → that HTTP error
 * - `[chunks:N]` → stream N text deltas (default `chunks`)
 * - `[interval:MS]` → delay between deltas (default `intervalMs`)
 * The API key `bad-key` is rejected with 401.
 */
export interface FakeAnthropicOptions {
  chunks?: number;
  intervalMs?: number;
}

export interface FakeAnthropic {
  url: string;
  /** Requests whose client disconnected before the stream finished. */
  readonly aborted: number;
  /** Messages requests received, with the parsed body. */
  readonly requests: Array<{ apiKey: string | undefined; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

const ERROR_TYPES: Record<number, string> = {
  401: 'authentication_error',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

export async function startFakeAnthropic(opts: FakeAnthropicOptions = {}): Promise<FakeAnthropic> {
  const state = { aborted: 0, requests: [] as FakeAnthropic['requests'] };
  const server: Server = createServer((req, res) => {
    void handle(req, res, opts, state).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: FakeAnthropicOptions,
  state: { aborted: number; requests: FakeAnthropic['requests'] },
): Promise<void> {
  const apiKey = header(req, 'x-api-key');
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (apiKey === 'bad-key') return sendError(res, 401);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      data: [
        {
          type: 'model',
          id: 'claude-haiku-4-5',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
        },
      ],
      has_more: false,
      first_id: 'claude-haiku-4-5',
      last_id: 'claude-haiku-4-5',
    });
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/messages') return sendJson(res, 404, {});

  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  state.requests.push({ apiKey, body });
  const prompt = lastUserText(body);

  const error = /\[error:(\d{3})\]/.exec(prompt);
  if (error) return sendError(res, Number(error[1]));

  const chunks = Number(/\[chunks:(\d+)\]/.exec(prompt)?.[1] ?? opts.chunks ?? 20);
  const intervalMs = Number(/\[interval:(\d+)\]/.exec(prompt)?.[1] ?? opts.intervalMs ?? 10);
  const model = typeof body.model === 'string' ? body.model : 'claude-haiku-4-5';
  const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));

  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      state.aborted++;
    }
  });

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

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
        input_tokens: inputTokens,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (let i = 0; i < chunks; i++) {
    if (closed) return;
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: `chunk ${i} ` },
    });
    await sleep(intervalMs);
  }
  if (closed) return;
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: chunks * 2 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function sendError(res: ServerResponse, status: number): void {
  // x-should-retry: false keeps the SDK from retrying so tests stay fast.
  res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  res.end(
    JSON.stringify({
      type: 'error',
      error: { type: ERROR_TYPES[status] ?? 'api_error', message: `fake ${status}` },
    }),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
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

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role: string; content: unknown }>)
    : [];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return '';
  return (last.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
