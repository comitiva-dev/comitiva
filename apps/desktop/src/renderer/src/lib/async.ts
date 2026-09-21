import type { ErrorCode } from '@comitiva/contract';

/** The state of one async action in the UI. */
export type Async<T> =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; value: T }
  | { state: 'failed'; code: ErrorCode };
