import {
  AppError,
  type ApprovalDecision,
  type Block,
  type Conversation,
  type IpcEventPayload,
  type Message,
  type PendingApproval,
} from '@comitiva/contract';
import type { Database } from '../../db/Database';
import type { AgentRepository } from '../../db/repositories/AgentRepository';
import type { ConnectionRepository } from '../../db/repositories/ConnectionRepository';
import type { ConversationRepository } from '../../db/repositories/ConversationRepository';
import type { MessageRepository } from '../../db/repositories/MessageRepository';
import type { ToolApprovalRepository } from '../../db/repositories/ToolApprovalRepository';
import type { UsageRepository } from '../../db/repositories/UsageRepository';
import type { AttachmentService } from '../AttachmentService';
import { placeholderTitle } from '../TitleService';
import type { ToolServerService } from '../ToolServerService';
import type { ChatStore, RunOutcome, RunSession, RunTarget, Turn, TurnInput } from './ChatStore';

export interface LocalChatEvents {
  'conversation.updated': [IpcEventPayload<'conversation.updated'>];
  'message.updated': [IpcEventPayload<'message.updated'>];
  'message.delta': [IpcEventPayload<'message.delta'>];
  'message.block': [IpcEventPayload<'message.block'>];
}

export interface LocalChatStoreDeps {
  db: Database;
  conversations: ConversationRepository;
  messages: MessageRepository;
  usage: UsageRepository;
  agents: AgentRepository;
  connections: ConnectionRepository;
  approvals: ToolApprovalRepository;
  toolServers: Pick<ToolServerService, 'launchesFor'>;
  attachments: Pick<AttachmentService, 'resolve'>;
  emit<C extends keyof LocalChatEvents>(channel: C, payload: LocalChatEvents[C][0]): void;
  /** The pending approval of a live run, which conversation events carry. */
  pendingOf(conversationId: string): PendingApproval | null;
  timing?: { uiFlushMs?: number; dbFlushMs?: number };
}

/**
 * Personal conversations: SQLite, and events to this window. Text is
 * coalesced to the UI at most once per frame (16 ms) and checkpointed to
 * SQLite about every 250 ms; the final state, the usage record and the
 * status are written in one transaction. Every message event carries the
 * conversation's `rev`, so a page read mid-stream lines up (ADR 0008).
 */
export class LocalChatStore implements ChatStore {
  /** Event revision per conversation: +1 on every message event. */
  private readonly revs = new Map<string, number>();
  readonly uiFlushMs: number;
  readonly dbFlushMs: number;

  constructor(private readonly deps: LocalChatStoreDeps) {
    this.uiFlushMs = deps.timing?.uiFlushMs ?? 16;
    this.dbFlushMs = deps.timing?.dbFlushMs ?? 250;
  }

  async target(conversationId: string): Promise<RunTarget> {
    const conversation = this.deps.conversations.require(conversationId);
    const agent = this.deps.agents.require(conversation.agentId);
    const { connection } = this.deps.connections.require(agent.connectionId);
    return { agent, connection, launches: () => this.deps.toolServers.launchesFor(agent) };
  }

  checkRetry(conversationId: string): void {
    this.deps.conversations.require(conversationId);
    const last = this.deps.messages.last(conversationId);
    if (!last || last.role !== 'assistant' || last.status !== 'error') {
      throw new AppError('invalid_request', 'The last reply did not fail');
    }
  }

  alwaysAllowed(agentId: string): string[] {
    return this.deps.approvals.alwaysAllowed(agentId);
  }

  harnessSession(conversationId: string, connectionId: string): string | undefined {
    return this.deps.conversations.harnessSession(conversationId, connectionId);
  }

  setHarnessSession(conversationId: string, sessionId: string, connectionId: string): void {
    this.deps.conversations.setHarnessSession(conversationId, sessionId, connectionId);
  }

  resolveHistory(messages: Message[]): Message[] {
    return this.deps.attachments.resolve(messages);
  }

  async beginTurn({ conversationId, content, target }: TurnInput): Promise<Turn> {
    const { db, conversations, messages } = this.deps;
    let reply: Message;
    if (content !== null) {
      const conversation = conversations.require(conversationId);
      const now = new Date().toISOString();
      const written = db.transaction(() => {
        const user = messages.insert(conversationId, 'user', content, 'complete', now);
        const reply = messages.insert(conversationId, 'assistant', [], 'streaming', now);
        if (conversation.title === null) {
          const title = placeholderTitle(content);
          if (title) conversations.rename(conversationId, title);
        }
        conversations.setStatus(conversationId, 'running');
        return { user, reply, updated: conversations.touch(conversationId, now) };
      });
      this.messageUpdated(written.user);
      this.messageUpdated(written.reply);
      this.updated(written.updated);
      reply = written.reply;
    } else {
      this.checkRetry(conversationId);
      const last = messages.last(conversationId)!;
      const written = db.transaction(() => {
        const reply = messages.reset(last.id);
        conversations.setStatus(conversationId, 'running');
        return { reply, updated: conversations.touch(conversationId) };
      });
      this.messageUpdated(written.reply);
      this.updated(written.updated);
      reply = written.reply;
    }
    const history = messages.all(conversationId).filter((m) => m.seq < reply.seq);
    return { reply, history, session: new LocalRunSession(this, this.deps, reply, target) };
  }

  /** The `rev` a page of this conversation reflects. */
  rev(conversationId: string): number {
    return this.revs.get(conversationId) ?? 0;
  }

  nextRev(conversationId: string): number {
    const rev = (this.revs.get(conversationId) ?? 0) + 1;
    this.revs.set(conversationId, rev);
    return rev;
  }

  messageUpdated(message: Message): void {
    this.deps.emit('message.updated', { message, rev: this.nextRev(message.conversationId) });
  }

  updated(conversation: Conversation): Conversation {
    this.deps.emit('conversation.updated', {
      conversation,
      pendingApproval: this.deps.pendingOf(conversation.id),
    });
    return conversation;
  }
}

class LocalRunSession implements RunSession {
  private pendingText = '';
  private blocks: readonly Block[] = [];
  private uiTimer: NodeJS.Timeout | undefined;
  private dbTimer: NodeJS.Timeout | undefined;
  private readonly conversationId: string;

  constructor(
    private readonly store: LocalChatStore,
    private readonly deps: LocalChatStoreDeps,
    private readonly reply: Message,
    private readonly target: RunTarget,
  ) {
    this.conversationId = reply.conversationId;
  }

  text(delta: string, blocks: readonly Block[]): void {
    this.blocks = blocks;
    this.pendingText += delta;
    this.uiTimer ??= setTimeout(() => this.flush(), this.store.uiFlushMs);
    this.scheduleDb();
  }

  block(block: Block, blocks: readonly Block[]): void {
    this.flush(); // pending text goes out before the block
    this.blocks = blocks;
    this.deps.emit('message.block', {
      conversationId: this.conversationId,
      messageId: this.reply.id,
      rev: this.store.nextRev(this.conversationId),
      block,
    });
    this.scheduleDb();
  }

  toolCall(): void {}

  awaitingApproval(): void {
    this.store.updated(this.deps.conversations.setStatus(this.conversationId, 'awaiting-approval'));
  }

  decided(pending: PendingApproval, decision: ApprovalDecision): void {
    const conversation = this.deps.db.transaction(() => {
      this.deps.approvals.insert({
        conversationId: this.conversationId,
        agentId: this.target.agent.id,
        toolUseId: pending.toolUseId,
        toolServerId: pending.toolServerId,
        toolName: pending.toolName,
        input: pending.input,
        decision,
      });
      return this.deps.conversations.setStatus(this.conversationId, 'running');
    });
    this.store.updated(conversation);
  }

  flush(): void {
    clearTimeout(this.uiTimer);
    this.uiTimer = undefined;
    if (!this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = '';
    this.deps.emit('message.delta', {
      conversationId: this.conversationId,
      messageId: this.reply.id,
      rev: this.store.nextRev(this.conversationId),
      text,
    });
  }

  finish(outcome: RunOutcome): Message {
    this.flush();
    this.close();
    const { conversations, messages, usage } = this.deps;
    const { agent, connection } = this.target;
    const { message, conversation } = this.deps.db.transaction(() => {
      const message = messages.finish(this.reply.id, outcome.status, outcome.blocks, outcome.error);
      const u = outcome.usage;
      if (u) {
        usage.insert({
          connectionId: connection.id,
          agentId: agent.id,
          conversationId: this.conversationId,
          messageId: this.reply.id,
          provider: connection.provider,
          model: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          estimated: u.estimated,
          reportedCostUsd: u.reportedCostUsd,
          latencyMs: u.latencyMs,
        });
      }
      conversations.setStatus(this.conversationId, outcome.status === 'error' ? 'error' : 'idle');
      return { message, conversation: conversations.touch(this.conversationId) };
    });
    this.store.messageUpdated(message);
    this.store.updated(conversation);
    return message;
  }

  close(): void {
    clearTimeout(this.uiTimer);
    clearTimeout(this.dbTimer);
    this.uiTimer = this.dbTimer = undefined;
  }

  titleCandidate(reply: Message): { user: Message; placeholder: string | null } | null {
    const all = this.deps.messages.all(this.conversationId);
    const replies = all.filter((m) => m.role === 'assistant' && m.status === 'complete');
    const user = all.find((m) => m.role === 'user');
    if (!user || replies.length !== 1 || replies[0]!.id !== reply.id) return null;
    const placeholder = placeholderTitle(user.content);
    if (this.deps.conversations.get(this.conversationId)?.title !== placeholder) return null;
    return { user, placeholder };
  }

  applyTitle(title: string, placeholder: string | null): void {
    const current = this.deps.conversations.get(this.conversationId);
    if (!current || current.title !== placeholder) return;
    this.store.updated(this.deps.conversations.rename(this.conversationId, title));
  }

  private scheduleDb(): void {
    this.dbTimer ??= setTimeout(() => {
      this.dbTimer = undefined;
      try {
        this.deps.messages.setContent(this.reply.id, [...this.blocks]);
      } catch (err) {
        console.error('LocalChatStore: checkpoint failed', AppError.from(err).message);
      }
    }, this.store.dbFlushMs);
  }
}
