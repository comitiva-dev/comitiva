import {
  AppError,
  type ErrorCode,
  type Message,
  type StopReason,
  type TestResult,
} from '@comitiva/contract';
import type { AdapterEvent, RunInput } from '../ProviderAdapter.js';

/**
 * Pieces every API adapter shares: error mapping, usage accounting, the
 * cancel/terminal-event rules of a turn, and timeouts for one-shot calls.
 * See docs/providers.md.
 */

export const PROBE_TIMEOUT_MS = 15_000;

// ------------------------------------------------------------------ errors

/** Maps an HTTP status to a stable code: 401/403 auth, 429 rate, 5xx unavailable. */
export function httpError(status: number, message: string, cause?: unknown): AppError {
  const opts = (retryable: boolean) => ({ retryable, cause });
  if (status === 401 || status === 403) return new AppError('auth_failed', message, opts(false));
  if (status === 429) return new AppError('rate_limited', message, opts(true));
  if (status === 408) return new AppError('timeout', message, opts(true));
  if (status >= 500) return new AppError('provider_unavailable', message, opts(true));
  return new AppError('provider_error', message, opts(false));
}

/** Errors that never got an HTTP response: timeouts, refused connections, DNS. */
export function networkError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  const code: ErrorCode = isTimeout(err) ? 'timeout' : 'provider_unavailable';
  return new AppError(code, message, { retryable: true, cause: err });
}

/** fetch() rejects with TypeError('fetch failed') and the socket error as `cause`. */
export function isFetchFailure(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    (err.message === 'fetch failed' || typeof (err.cause as { code?: unknown })?.code === 'string')
  );
}

function isTimeout(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.name === 'TimeoutError' || /timed? ?out/i.test(e.message)) return true;
    if ((e as NodeJS.ErrnoException).code === 'ETIMEDOUT') return true;
  }
  return false;
}

/**
 * Runs a one-shot call (test, list models) with a deadline. The deadline
 * aborts the request and surfaces as `timeout`; anything else goes through
 * the adapter's own mapping.
 */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  toAppError: (err: unknown) => AppError,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fn(signal);
  } catch (err) {
    if (signal.aborted) {
      throw new AppError('timeout', `No answer within ${timeoutMs} ms`, {
        retryable: true,
        cause: err,
      });
    }
    throw toAppError(err);
  }
}

/** Times a probe and folds failures into a TestResult (never throws). */
export async function probe(
  fn: (signal: AbortSignal) => Promise<unknown>,
  toAppError: (err: unknown) => AppError,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<TestResult> {
  const started = performance.now();
  try {
    await withDeadline(fn, toAppError, timeoutMs);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, error: AppError.from(err).toJSON() };
  }
}

// ------------------------------------------------------------------- usage

/** ~4 characters per token: the fallback when a provider does not report usage. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Collects what the provider reports and fills the gaps with estimates, so a
 * turn always ends with one `run.usage` (with `estimated: true` when any part
 * was guessed, e.g. on cancel before the final usage arrives).
 */
export class UsageTracker {
  private input: number | undefined;
  private output: number | undefined;
  private cacheRead: number | undefined;
  private cacheWrite: number | undefined;
  private final = false;
  private streamedChars = 0;

  constructor(private readonly estimatedInput: number) {}

  static for(input: RunInput): UsageTracker {
    const chars = input.system.length + input.messages.reduce((n, m) => n + textLength(m), 0);
    return new UsageTracker(estimateTokens(chars));
  }

  addText(text: string): void {
    this.streamedChars += text.length;
  }

  /** Records provider-reported counts; `final` marks the complete usage of the turn. */
  report(u: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    final?: boolean;
  }): void {
    if (u.input !== undefined) this.input = u.input;
    if (u.output !== undefined) this.output = u.output;
    if (u.cacheRead !== undefined) this.cacheRead = u.cacheRead;
    if (u.cacheWrite !== undefined) this.cacheWrite = u.cacheWrite;
    if (u.final) this.final = true;
  }

  event(): AdapterEvent {
    const complete = this.final && this.input !== undefined && this.output !== undefined;
    return {
      type: 'run.usage',
      inputTokens: this.input ?? this.estimatedInput,
      outputTokens: complete
        ? this.output!
        : Math.max(this.output ?? 0, estimateTokens(this.streamedChars)),
      ...(this.cacheRead !== undefined ? { cacheReadTokens: this.cacheRead } : {}),
      ...(this.cacheWrite !== undefined ? { cacheWriteTokens: this.cacheWrite } : {}),
      estimated: !complete,
    };
  }
}

function textLength(m: Message): number {
  return m.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);
}

// -------------------------------------------------------------------- turn

/**
 * Wraps one streamed model call with the rules every adapter follows:
 * text deltas are counted for usage estimates; on normal end it yields usage
 * then `done { stopReason }`; on abort it yields the usage known so far and
 * `done { cancelled }` (never an error); other failures are mapped and thrown
 * (the Run turns them into `run.error`).
 *
 * `body` yields events and returns the stop reason.
 */
export async function* streamTurn(opts: {
  signal: AbortSignal;
  usage: UsageTracker;
  toAppError: (err: unknown) => AppError;
  body: () => AsyncGenerator<AdapterEvent, StopReason>;
}): AsyncGenerator<AdapterEvent> {
  const { signal, usage } = opts;
  let stopReason: StopReason = 'other';
  // Cancel must end the turn promptly even if an SDK keeps a stream open
  // after its signal fired, so every read races the abort.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});
  const it = opts.body();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), aborted]);
      if (next.done) {
        stopReason = next.value;
        break;
      }
      if (next.value.type === 'run.text_delta') usage.addText(next.value.text);
      yield next.value;
    }
  } catch (err) {
    if (!signal.aborted) throw opts.toAppError(err);
    // Let the body run its cleanup (closing the stream) in the background.
    it.return(stopReason).catch(() => {});
  }
  yield usage.event();
  yield { type: 'run.done', stopReason: signal.aborted ? 'cancelled' : stopReason };
}

// --------------------------------------------------------------- messages

/** Text-only view of a canonical message, for providers without block support yet. */
export function plainText(m: Message, provider: string): string {
  if (m.role === 'tool') {
    throw new AppError('unsupported_content', `Tool results are not supported by ${provider} yet`);
  }
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      throw new AppError(
        'unsupported_content',
        `${b.type} blocks are not supported by ${provider} yet`,
      );
    })
    .join('\n');
}

/** Removes trailing slashes so paths can be appended safely. */
export const trimSlash = (url: string): string => url.replace(/\/+$/, '');
