import {
  AppError,
  type Block,
  type ErrorCode,
  type Message,
  type StopReason,
  type TestResult,
  type ToolResultBlock,
} from '@comitiva/contract';
import type { AdapterEvent, RunInput } from '../ProviderAdapter.js';
import { countPrompt, countText } from '../../usage/Tokenizer.js';

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

/**
 * Collects what the provider reports and fills the gaps with estimates, so a
 * turn always ends with one `run.usage` (with `estimated: true` when any part
 * was guessed, e.g. on cancel before the final usage arrives). A turn with
 * tools makes several model calls: `nextCall()` closes one and the event sums
 * them all.
 */
export class UsageTracker {
  private input: number | undefined;
  private output: number | undefined;
  private cacheRead: number | undefined;
  private cacheWrite: number | undefined;
  private final = false;
  private streamedText = '';
  private model: string | undefined;
  private reportedCostUsd: number | undefined;
  /** Sums of the calls already closed by `nextCall()`. */
  private done: UsageSum | null = null;

  constructor(
    private estimatedInput: number,
    private readonly system: string = '',
  ) {}

  static for(input: RunInput): UsageTracker {
    return new UsageTracker(countPrompt(input.system, input.messages), input.system);
  }

  /**
   * Re-reads the prompt before another model call. The tool loop grows the
   * history every iteration, so an estimate taken once at the start would
   * describe only the first call.
   */
  seed(messages: readonly Message[]): void {
    this.estimatedInput = countPrompt(this.system, messages);
  }

  addText(text: string): void {
    this.streamedText += text;
  }

  /**
   * Records provider-reported counts; `final` marks the complete usage of the
   * call. `input` must be net of `cacheRead`: providers disagree (OpenAI and
   * Gemini include cached tokens in their prompt count, Anthropic does not),
   * so each adapter subtracts before reporting and every consumer can price
   * the two at their own rates.
   */
  report(u: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    model?: string | undefined;
    costUsd?: number | undefined;
    final?: boolean;
  }): void {
    if (u.input !== undefined) this.input = u.input;
    if (u.output !== undefined) this.output = u.output;
    if (u.cacheRead !== undefined) this.cacheRead = u.cacheRead;
    if (u.cacheWrite !== undefined) this.cacheWrite = u.cacheWrite;
    if (u.model !== undefined && u.model !== '') this.model = u.model;
    if (u.costUsd !== undefined) this.reportedCostUsd = u.costUsd;
    if (u.final) this.final = true;
  }

  /** Closes the current model call (the tool loop is about to make another). */
  nextCall(): void {
    this.done = this.sum();
    this.input = this.output = this.cacheRead = this.cacheWrite = undefined;
    this.final = false;
    this.streamedText = '';
  }

  event(): AdapterEvent {
    const s = this.sum();
    return {
      type: 'run.usage',
      inputTokens: s.input,
      outputTokens: s.output,
      ...(s.cacheRead !== undefined ? { cacheReadTokens: s.cacheRead } : {}),
      ...(s.cacheWrite !== undefined ? { cacheWriteTokens: s.cacheWrite } : {}),
      estimated: s.estimated,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.reportedCostUsd !== undefined ? { reportedCostUsd: this.reportedCostUsd } : {}),
    };
  }

  /** The closed calls plus the current one. */
  private sum(): UsageSum {
    const complete = this.final && this.input !== undefined && this.output !== undefined;
    const current: UsageSum = {
      input: this.input ?? this.estimatedInput,
      output: complete ? this.output! : Math.max(this.output ?? 0, countText(this.streamedText)),
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      estimated: !complete,
    };
    const d = this.done;
    if (!d) return current;
    const add = (a: number | undefined, b: number | undefined) =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    return {
      input: d.input + current.input,
      output: d.output + current.output,
      cacheRead: add(d.cacheRead, current.cacheRead),
      cacheWrite: add(d.cacheWrite, current.cacheWrite),
      estimated: d.estimated || current.estimated,
    };
  }
}

interface UsageSum {
  input: number;
  output: number;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  estimated: boolean;
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
    if (!signal.aborted) {
      // A failed turn still spent tokens, and the shell has to record them:
      // without this the run is billed by the provider and forgotten here.
      yield usage.event();
      throw opts.toAppError(err);
    }
    // Let the body run its cleanup (closing the stream) in the background.
    it.return(stopReason).catch(() => {});
  }
  yield usage.event();
  yield { type: 'run.done', stopReason: signal.aborted ? 'cancelled' : stopReason };
}

// --------------------------------------------------------------- messages

/**
 * Text of a message's text blocks, for providers without image or document
 * support yet (tool blocks are translated by each adapter).
 */
export function plainText(blocks: readonly Block[], provider: string): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      throw new AppError(
        'unsupported_content',
        `${b.type} blocks are not supported by ${provider} yet`,
      );
    })
    .join('\n');
}

/** A tool result as one string, for providers whose tool messages are text only. */
export function toolResultText(block: ToolResultBlock): string {
  const text = block.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} not shown]`))
    .join('\n');
  return block.isError && !/^[a-z_]+: /.test(text) ? `error: ${text}` : text;
}

/** A tool call's JSON input; an empty or cut-off one becomes `{}`. */
export function parseJson(json: string): unknown {
  if (json.trim() === '') return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

/** Removes trailing slashes so paths can be appended safely. */
export const trimSlash = (url: string): string => url.replace(/\/+$/, '');
