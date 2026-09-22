import { z } from 'zod';

/**
 * Stable error codes. The UI translates by code and never shows a raw provider
 * message as a title.
 */
export const ErrorCode = z.enum([
  'auth_failed',
  'rate_limited',
  'provider_unavailable',
  'provider_error',
  'binary_not_found',
  'not_logged_in',
  'sandbox_unavailable',
  'outside_roots',
  'read_only_root',
  'approval_denied',
  'tool_failed',
  'tool_server_failed',
  'invalid_request',
  'not_implemented',
  'unknown_provider',
  'not_found',
  'unsupported_content',
  'connection_in_use',
  'connection_disabled',
  'model_required',
  'secret_missing',
  'secret_store_unavailable',
  'oauth_not_configured',
  'oauth_failed',
  'oauth_cancelled',
  'google_not_connected',
  'google_reconnect_required',
  'runner_crashed',
  'runner_unavailable',
  'conversation_busy',
  'interrupted',
  'timeout',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Wire shape of an error: what crosses process boundaries. */
export const AppErrorShape = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type AppErrorShape = z.infer<typeof AppErrorShape>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): AppErrorShape {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }

  static fromShape(shape: AppErrorShape): AppError {
    return new AppError(shape.code, shape.message, { retryable: shape.retryable });
  }

  /** Normalizes anything thrown into an AppError, defaulting to `internal`. */
  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError('internal', message, { cause: err });
  }
}
