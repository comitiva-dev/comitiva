import { ulid } from 'ulid';
import {
  titleModelFor,
  type Agent,
  type Block,
  type Connection,
  type Message,
  type RunEvent,
} from '@comitiva/contract';
import type { UsageRepository } from '../db/repositories/UsageRepository';
import type { RunnerPort } from './ConversationService';

const MAX_TITLE = 60;
/** How much of the first exchange the title model sees. */
const MAX_EXCERPT = 2000;

const TITLE_ROLE =
  'You name conversations. Reply with a short title (at most 6 words) for the conversation ' +
  'below, in the language the user wrote in. No quotes, no trailing punctuation, nothing else.';

/** The text of a message's text blocks. */
export function textOf(content: readonly Block[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The title a conversation gets as soon as its first message is sent: the
 * first non-blank line, whitespace collapsed, at most 60 characters. Null when
 * the message has no text (an image alone).
 */
export function placeholderTitle(content: readonly Block[]): string | null {
  const line = textOf(content)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l !== '');
  return line ? clip(line, MAX_TITLE) : null;
}

/** A model's answer as a title: one line, no wrapping quotes or trailing punctuation. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return null;
  const title = line
    .replace(/^(title|título)\s*:\s*/i, '')
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s]+$/g, '')
    .replace(/[.!?:;,。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title ? clip(title, MAX_TITLE) : null;
}

export interface TitleServiceDeps {
  runner: RunnerPort;
  usage: UsageRepository;
  secretFor(connection: Connection): Promise<string | undefined>;
  timeoutMs?: number;
}

export interface TitleRequest {
  conversationId: string;
  agent: Agent;
  connection: Connection;
  user: Message;
  reply: Message;
}

/**
 * Names a conversation after its first reply with a cheap model (per
 * provider, `titleModelFor`). It runs as its own runner run, outside the
 * conversation: no status change, nothing persisted but its usage (with
 * `messageId: null`). CLI harnesses and providers without a cheap model get
 * no title (the placeholder stays). Never throws.
 */
export class TitleService {
  constructor(private readonly deps: TitleServiceDeps) {}

  async generate(req: TitleRequest): Promise<string | null> {
    const { agent, connection } = req;
    if (connection.kind !== 'api') return null;
    const preset =
      connection.provider === 'openai-compatible' ? connection.config.preset : undefined;
    const model = titleModelFor(
      connection.provider,
      preset,
      agent.model ?? connection.config.defaultModel ?? '',
    );
    if (!model) return null;
    try {
      const secret = await this.deps.secretFor(connection);
      const text = await this.run(req, model, secret);
      return text === null ? null : cleanTitle(text);
    } catch {
      return null;
    }
  }

  private run(
    req: TitleRequest,
    model: string,
    secret: string | undefined,
  ): Promise<string | null> {
    const { runner } = this.deps;
    const runId = ulid();
    const startedAt = Date.now();
    const excerpt = clip(
      `User: ${textOf(req.user.content)}\n\nAssistant: ${textOf(req.reply.content)}`,
      MAX_EXCERPT,
    );
    const now = new Date().toISOString();
    const prompt: Message = {
      id: ulid(),
      conversationId: req.conversationId,
      role: 'user',
      content: [{ type: 'text', text: excerpt }],
      status: 'complete',
      seq: 0,
      createdAt: now,
      error: null,
    };
    const titler: Agent = {
      ...req.agent,
      model,
      role: TITLE_ROLE,
      params: { maxTokens: 24, temperature: 0.2 },
      toolServerIds: [],
      roots: [],
    };

    return new Promise((resolve) => {
      let text = '';
      const finish = (value: string | null) => {
        clearTimeout(timer);
        runner.off('run.event', onEvent);
        resolve(value);
      };
      const onEvent = (e: RunEvent & { receivedAt: number }) => {
        if (e.runId !== runId) return;
        if (e.type === 'run.text_delta') text += e.text;
        else if (e.type === 'run.usage') {
          this.recordUsage(req, model, e, startedAt);
        } else if (e.type === 'run.done') {
          finish(e.stopReason === 'end_turn' || e.stopReason === 'max_tokens' ? text : null);
        } else if (e.type === 'run.error') finish(null);
      };
      const timer = setTimeout(() => {
        runner.cancelRun(runId);
        finish(null);
      }, this.deps.timeoutMs ?? 30_000);
      runner.on('run.event', onEvent);
      runner.startRun({
        runId,
        conversationId: req.conversationId,
        agent: titler,
        connection: req.connection,
        messages: [prompt],
        ...(secret !== undefined ? { secret } : {}),
      });
    });
  }

  /** Title runs cost tokens too; a failed write must not throw into the runner's event handler. */
  private recordUsage(
    req: TitleRequest,
    model: string,
    e: Extract<RunEvent, { type: 'run.usage' }> & { receivedAt: number },
    startedAt: number,
  ): void {
    try {
      this.deps.usage.insert({
        connectionId: req.connection.id,
        agentId: req.agent.id,
        conversationId: req.conversationId,
        messageId: null,
        provider: req.connection.provider,
        model: e.model ?? model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens ?? null,
        cacheWriteTokens: e.cacheWriteTokens ?? null,
        estimated: e.estimated,
        reportedCostUsd: e.reportedCostUsd ?? null,
        latencyMs: Math.max(0, Math.round(e.receivedAt - startedAt)),
      });
    } catch (err) {
      console.error('TitleService: usage not recorded', err instanceof Error ? err.message : err);
    }
  }
}
