import type { StopReason, ToolResultContentBlock } from '@comitiva/contract';
import type { AdapterEvent } from '../../ProviderAdapter.js';
import type { UsageTracker } from '../../api/shared.js';
import type { HarnessExit } from '../process.js';

export interface ParserOptions {
  /** Receives the usage the harness reports. */
  usage: UsageTracker;
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void;
  /** Prefix for tool ids the harness only numbers per turn (Codex `item_0`). */
  idPrefix: string;
}

/**
 * Turns a harness's JSON lines into AdapterEvents. Pure: no I/O, so it is
 * tested against recorded fixtures line by line.
 */
export interface HarnessParser {
  push(line: unknown): AdapterEvent[];
  /** After exit: the stop reason, or throws the mapped AppError. */
  finish(exit: HarnessExit, stderr: string): StopReason;
  /** Whether the turn failed only because the session to resume does not exist. */
  sessionNotFound(stderr: string): boolean;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export const textContent = (text: string): ToolResultContentBlock[] =>
  text === '' ? [] : [{ type: 'text', text }];

/** First non-empty line of stderr, for error messages. */
export function stderrSummary(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}
