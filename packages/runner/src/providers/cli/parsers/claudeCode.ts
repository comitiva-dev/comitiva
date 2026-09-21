import { AppError, StopReason, type ToolResultContentBlock } from '@comitiva/contract';
import type { AdapterEvent } from '../../ProviderAdapter.js';
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

export const CLAUDE_CODE_TOOL_SERVER = 'harness:claude-code';
/** Calls to the runner's proxy: the run reports those itself (ToolBridge). */
const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;
const LOGIN = 'run `claude auth login` in a terminal';

/**
 * Claude Code `-p --output-format stream-json --verbose --include-partial-messages`.
 * Line formats: docs/providers.md → CLI harnesses → Claude Code.
 */
export class ClaudeCodeParser implements HarnessParser {
  private sessionId: string | undefined;
  private currentMessageId: string | undefined;
  private readonly streamedMessages = new Set<string>();
  private textSoFar = false;
  private separatorPending = false;
  private result: Record<string, unknown> | undefined;
  private error: AppError | undefined;
  private readonly bridgeCalls = new Set<string>();

  constructor(private readonly opts: ParserOptions) {}

  push(line: unknown): AdapterEvent[] {
    if (!isObject(line)) return [];
    // Subagent traffic (Task tool) belongs to a tool call, not to the reply.
    if (str(line.parent_tool_use_id)) return [];
    switch (line.type) {
      case 'system':
        return this.system(line);
      case 'stream_event':
        return this.streamEvent(line.event);
      case 'assistant':
        return this.assistant(line);
      case 'user':
        return this.user(line);
      case 'result':
        this.result = line;
        this.reportUsage(line.usage);
        return [];
      default:
        return []; // rate_limit_event, hook events, …
    }
  }

  private system(line: Record<string, unknown>): AdapterEvent[] {
    const id = str(line.session_id);
    if (line.subtype !== 'init' || !id || id === this.sessionId) return [];
    this.sessionId = id;
    return [{ type: 'run.session', harnessSessionId: id }];
  }

  private streamEvent(event: unknown): AdapterEvent[] {
    if (!isObject(event)) return [];
    if (event.type === 'message_start' && isObject(event.message)) {
      this.currentMessageId = str(event.message.id);
      return [];
    }
    if (event.type === 'content_block_start' && isObject(event.content_block)) {
      if (event.content_block.type === 'text' && this.textSoFar) this.separatorPending = true;
      return [];
    }
    if (event.type === 'content_block_delta' && isObject(event.delta)) {
      if (event.delta.type !== 'text_delta') return []; // thinking, tool input
      const text = str(event.delta.text) ?? '';
      if (text === '') return [];
      if (this.currentMessageId) this.streamedMessages.add(this.currentMessageId);
      return [this.text(text)];
    }
    return [];
  }

  private text(text: string): AdapterEvent {
    const prefix = this.separatorPending ? '\n\n' : '';
    this.separatorPending = false;
    this.textSoFar = true;
    return { type: 'run.text_delta', text: prefix + text };
  }

  private assistant(line: Record<string, unknown>): AdapterEvent[] {
    const message = isObject(line.message) ? line.message : {};
    const errorKind = str(line.error);
    const content = Array.isArray(message.content) ? message.content : [];
    if (errorKind) {
      const text = content
        .map((b) => (isObject(b) ? (str(b.text) ?? '') : ''))
        .join(' ')
        .trim();
      this.error ??= assistantError(errorKind, text);
      return [];
    }
    const streamed = this.streamedMessages.has(str(message.id) ?? '');
    const events: AdapterEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use' && str(block.name)?.startsWith(BRIDGE_TOOL_PREFIX)) {
        this.bridgeCalls.add(str(block.id) ?? '');
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'run.block',
          block: {
            type: 'tool_use',
            id: str(block.id) ?? '',
            toolServerId: CLAUDE_CODE_TOOL_SERVER,
            name: str(block.name) ?? 'unknown',
            input: block.input ?? {},
          },
        });
      } else if (block.type === 'text' && !streamed) {
        // Without --include-partial-messages (or if it is overridden), text only
        // arrives in the complete message.
        const text = str(block.text) ?? '';
        if (text !== '') {
          if (this.textSoFar) this.separatorPending = true;
          events.push(this.text(text));
        }
      }
    }
    return events;
  }

  private user(line: Record<string, unknown>): AdapterEvent[] {
    const message = isObject(line.message) ? line.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const events: AdapterEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      if (this.bridgeCalls.has(str(block.tool_use_id) ?? '')) continue;
      events.push({
        type: 'run.block',
        block: {
          type: 'tool_result',
          toolUseId: str(block.tool_use_id) ?? '',
          content: toolResultContent(block.content),
          isError: block.is_error === true,
        },
      });
    }
    return events;
  }

  private reportUsage(usage: unknown): void {
    if (!isObject(usage)) return;
    this.opts.usage.report({
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      final: true,
    });
  }

  sessionNotFound(stderr: string): boolean {
    const errors = this.result && Array.isArray(this.result.errors) ? this.result.errors : [];
    return [...errors, stderr].some(
      (e) => typeof e === 'string' && /No conversation found with session ID/i.test(e),
    );
  }

  finish(exit: HarnessExit, stderr: string): StopReason {
    if (this.error) throw this.error;
    const r = this.result;
    if (!r) {
      const detail = stderrSummary(stderr);
      throw new AppError(
        'provider_error',
        `Claude Code exited (${exit.signal ?? exit.code}) without a result${detail ? `: ${detail}` : ''}`,
      );
    }
    if (r.is_error === true) {
      const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === 'string') : [];
      const message = errors.join('; ') || str(r.result) || stderrSummary(stderr) || 'failed';
      if (/not logged in|\/login/i.test(message)) {
        throw new AppError('not_logged_in', `Claude Code is not logged in; ${LOGIN}`);
      }
      throw new AppError('provider_error', `Claude Code: ${message}`);
    }
    if (r.subtype === 'error_max_turns') return 'max_iterations';
    const parsed = StopReason.safeParse(r.stop_reason);
    return parsed.success ? parsed.data : 'end_turn';
  }
}

/** `assistant.error` values seen from Claude Code, mapped to stable codes. */
function assistantError(kind: string, text: string): AppError {
  const detail = text || kind;
  if (kind === 'authentication_failed' || /not logged in/i.test(text)) {
    return new AppError('not_logged_in', `Claude Code is not logged in; ${LOGIN}`);
  }
  if (/rate_limit/.test(kind)) return new AppError('rate_limited', detail, { retryable: true });
  if (/server_error|overloaded|unavailable/.test(kind)) {
    return new AppError('provider_unavailable', detail, { retryable: true });
  }
  return new AppError('provider_error', `Claude Code: ${detail}`);
}

function toolResultContent(content: unknown): ToolResultContentBlock[] {
  if (typeof content === 'string') return textContent(content);
  if (!Array.isArray(content)) return [];
  const out: ToolResultContentBlock[] = [];
  for (const b of content) {
    if (!isObject(b)) continue;
    if (b.type === 'text') out.push(...textContent(str(b.text) ?? ''));
    else if (b.type === 'image' && isObject(b.source) && b.source.type === 'base64') {
      out.push({
        type: 'image',
        source: {
          kind: 'base64',
          mediaType: str(b.source.media_type) ?? 'image/png',
          data: str(b.source.data) ?? '',
        },
      });
    }
  }
  return out;
}
