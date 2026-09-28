import { AppError, ErrorCode, HubMeta } from '@comitiva/contract';

export interface HubClientOptions {
  /** The hub's base URL, without a trailing slash. */
  baseUrl: string;
  /** The device's personal access token; null for public endpoints. */
  token: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HubRequestOptions {
  query?: Record<string, string> | undefined;
  body?: unknown;
}

/**
 * The hub's REST API (the hub's docs/api.md), with the token main keeps.
 * Errors become AppErrors with the hub's stable code; a hub that cannot be
 * reached is `hub_unreachable` (retryable). No Electron import: tests run it
 * under plain Node against a fake hub.
 */
export class HubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HubClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: HubRequestOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, options, 'application/json');
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError(
        'hub_unreachable',
        `The hub answered ${path} with something that is not JSON`,
        {
          retryable: true,
        },
      );
    }
  }

  /** A file (an attachment), as bytes and its type. */
  async download(path: string): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.send('GET', path, {}, '*/*');
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /** What the hub says about itself; hub_incompatible is decided by the caller. */
  async meta(): Promise<HubMeta> {
    const raw = await this.request('GET', '/api/v1/meta');
    const parsed = HubMeta.safeParse(raw);
    if (!parsed.success) {
      throw new AppError('hub_incompatible', 'This address does not answer like a Comitiva hub');
    }
    return parsed.data;
  }

  /** Authorizes a private or presence channel for a socket (Pusher protocol). */
  async authorizeChannel(
    socketId: string,
    channel: string,
  ): Promise<{ auth: string; channel_data?: string }> {
    return this.request('POST', '/broadcasting/auth', {
      body: { socket_id: socketId, channel_name: channel },
    });
  }

  private async send(
    method: string,
    path: string,
    { query, body }: HubRequestOptions,
    accept: string,
  ): Promise<Response> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: accept };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new AppError('hub_unreachable', `Could not reach the hub: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    if (!res.ok) throw await toError(res);
    return res;
  }
}

/** The hub's `{ error }` body when there is one, else a code from the status. */
async function toError(res: Response): Promise<AppError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: fall back to the status
  }
  const error = (body as { error?: { code?: unknown; message?: unknown; retryable?: unknown } })
    ?.error;
  const parsed = ErrorCode.safeParse(error?.code);
  if (parsed.success) {
    return new AppError(parsed.data, typeof error?.message === 'string' ? error.message : '', {
      retryable: error?.retryable === true,
    });
  }
  const status = res.status;
  if (status === 401 || status === 419) return new AppError('hub_auth_required', 'Sign in again');
  if (status === 403) return new AppError('forbidden', 'Not allowed');
  if (status === 404) return new AppError('not_found', 'Not found on the hub');
  if (status === 429) return new AppError('rate_limited', 'Too many requests', { retryable: true });
  if (status >= 500)
    return new AppError('hub_unreachable', `The hub failed (${status})`, { retryable: true });
  return new AppError('invalid_request', `The hub refused the request (${status})`);
}
