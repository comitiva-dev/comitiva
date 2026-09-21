import { AppError, type StopReason } from '@comitiva/contract';
import type { AdapterEvent } from '../../ProviderAdapter.js';
import { httpError } from '../../api/shared.js';
import { BRIDGE_SERVER_NAME } from '../../../mcp/names.js';
import type { HarnessExit } from '../process.js';
import {
  isObject,
  num,
  stderrSummary,
  str,
  textContent,
  type HarnessParser,
  type ParserOptions,
} from './types.js';

export const CODEX_TOOL_SERVER = 'harness:codex';
const LOGIN = 'run `codex login` in a terminal';

/**
 * Codex `exec --json`. Assistant text arrives one whole message at a time
 * (no token deltas). Line formats: docs/providers.md → CLI harnesses → Codex.
 */
export class CodexParser implements HarnessParser {
  private threadId: string | undefined;
  private textSoFar = false;
  private completed = false;
  private failure: string | undefined;
  private readonly started = new Set<string>();

  constructor(private readonly opts: ParserOptions) {}

  push(line: unknown): AdapterEvent[] {
    if (!isObject(line)) return [];
    switch (line.type) {
      case 'thread.started': {
        const id = str(line.thread_id);
        if (!id || id === this.threadId) return [];
        this.threadId = id;
        return [{ type: 'run.session', harnessSessionId: id }];
      }
      case 'item.started':
        return isObject(line.item) ? this.itemStarted(line.item) : [];
      case 'item.completed':
        return isObject(line.item) ? this.itemCompleted(line.item) : [];
      case 'turn.completed':
        this.completed = true;
        this.reportUsage(line.usage);
        return [];
      case 'turn.failed':
        this.failure = isObject(line.error) ? (str(line.error.message) ?? 'failed') : 'failed';
        return [];
      case 'error':
        // Reconnect notices; the terminal failure comes as turn.failed.
        this.opts.log('debug', `codex: ${str(line.message) ?? 'error'}`);
        return [];
      default:
        return [];
    }
  }

  private id(item: Record<string, unknown>): string {
    return `${this.opts.idPrefix}${str(item.id) ?? ''}`;
  }

  private toolUse(item: Record<string, unknown>): AdapterEvent[] {
    const id = this.id(item);
    if (this.started.has(id)) return [];
    this.started.add(id);
    const [name, input] = describeTool(item);
    return [
      {
        type: 'run.block',
        block: { type: 'tool_use', id, toolServerId: CODEX_TOOL_SERVER, name, input },
      },
    ];
  }

  private itemStarted(item: Record<string, unknown>): AdapterEvent[] {
    return isTool(item) && !isBridgeCall(item) ? this.toolUse(item) : [];
  }

  private itemCompleted(item: Record<string, unknown>): AdapterEvent[] {
    if (item.type === 'agent_message') {
      const text = str(item.text) ?? '';
      if (text === '') return [];
      const prefix = this.textSoFar ? '\n\n' : '';
      this.textSoFar = true;
      return [{ type: 'run.text_delta', text: prefix + text }];
    }
    if (item.type === 'error') {
      this.opts.log('debug', `codex: ${str(item.message) ?? 'error item'}`);
      return [];
    }
    if (!isTool(item)) return []; // reasoning, todo lists, …
    if (isBridgeCall(item)) return []; // the run reports calls to its own proxy
    // A tool can complete without a start line; emit its use first.
    return [
      ...this.toolUse(item),
      {
        type: 'run.block',
        block: {
          type: 'tool_result',
          toolUseId: this.id(item),
          content: textContent(toolOutput(item)),
          isError: toolFailed(item),
        },
      },
    ];
  }

  private reportUsage(usage: unknown): void {
    if (!isObject(usage)) return;
    const input = num(usage.input_tokens);
    const cached = num(usage.cached_input_tokens) ?? 0;
    this.opts.usage.report({
      input: input === undefined ? undefined : Math.max(0, input - cached),
      output: num(usage.output_tokens),
      cacheRead: cached,
      cacheWrite: num(usage.cache_write_input_tokens),
      final: true,
    });
  }

  sessionNotFound(stderr: string): boolean {
    return !this.threadId && /no rollout found|thread\/resume failed/i.test(stderr);
  }

  finish(exit: HarnessExit, stderr: string): StopReason {
    if (this.failure !== undefined) throw turnFailed(this.failure);
    if (this.completed) return 'end_turn';
    const detail = stderrSummary(stderr);
    throw new AppError(
      'provider_error',
      `Codex exited (${exit.signal ?? exit.code}) before finishing the turn${detail ? `: ${detail}` : ''}`,
    );
  }
}

const TOOL_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
const isTool = (item: Record<string, unknown>) => TOOL_TYPES.has(str(item.type) ?? '');

/** A call to the runner's proxy: the run reports it itself (ToolBridge). */
function isBridgeCall(item: Record<string, unknown>): boolean {
  return item.type === 'mcp_tool_call' && item.server === BRIDGE_SERVER_NAME;
}

function describeTool(item: Record<string, unknown>): [string, unknown] {
  switch (item.type) {
    case 'command_execution':
      return ['shell', { command: item.command }];
    case 'file_change':
      return ['apply_patch', { changes: item.changes ?? [] }];
    case 'mcp_tool_call':
      return [`${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}`, item.arguments ?? {}];
    default:
      return [str(item.type) ?? 'tool', { query: item.query }];
  }
}

function toolOutput(item: Record<string, unknown>): string {
  switch (item.type) {
    case 'command_execution':
      return str(item.aggregated_output) ?? '';
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes
        .map((c) => (isObject(c) ? `${str(c.kind) ?? 'change'} ${str(c.path) ?? ''}` : ''))
        .filter(Boolean)
        .join('\n');
    }
    case 'mcp_tool_call': {
      if (isObject(item.error)) return str(item.error.message) ?? 'error';
      return item.result === null || item.result === undefined ? '' : JSON.stringify(item.result);
    }
    default:
      return '';
  }
}

function toolFailed(item: Record<string, unknown>): boolean {
  if (item.status === 'failed' || item.status === 'declined') return true;
  if (item.type === 'command_execution') {
    const code = num(item.exit_code);
    return code !== undefined && code !== 0;
  }
  return item.type === 'mcp_tool_call' && isObject(item.error);
}

/**
 * `turn.failed.error.message` is either the provider's JSON error (with a
 * status) or text such as "unexpected status 401 Unauthorized: …".
 */
export function turnFailed(message: string): AppError {
  let status: number | undefined;
  let detail = message;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isObject(parsed)) {
      status = num(parsed.status);
      if (isObject(parsed.error)) detail = str(parsed.error.message) ?? message;
    }
  } catch {
    status = num(Number(/\bstatus (\d{3})\b/.exec(message)?.[1]));
  }
  if (status === 401 && /missing bearer|not logged in|authentication/i.test(message)) {
    return new AppError('not_logged_in', `Codex is not logged in; ${LOGIN}`);
  }
  if (status !== undefined) return httpError(status, `Codex: ${detail}`);
  return new AppError('provider_error', `Codex: ${detail}`);
}
