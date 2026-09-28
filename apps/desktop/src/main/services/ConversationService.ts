import { EventEmitter } from 'node:events';
import type {
  ApprovalDecision,
  Connection,
  Conversation,
  ConversationSummary,
  MessagePage,
  UserContent,
} from '@comitiva/contract';
import type { Database } from '../db/Database';
import type { AgentRepository } from '../db/repositories/AgentRepository';
import type { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { ConversationRepository } from '../db/repositories/ConversationRepository';
import type { MessageRepository } from '../db/repositories/MessageRepository';
import type { ToolApprovalRepository } from '../db/repositories/ToolApprovalRepository';
import type { UsageRepository } from '../db/repositories/UsageRepository';
import type { TitleService } from './TitleService';
import type { AttachmentService } from './AttachmentService';
import type { ToolServerService } from './ToolServerService';
import { LocalChatStore, type LocalChatEvents } from './chat/LocalChatStore';
import { RunEngine, type RunnerPort } from './chat/RunEngine';

export { buildHistory, type RunnerPort } from './chat/RunEngine';

export type ConversationEvents = LocalChatEvents;

export interface ConversationServiceDeps {
  db: Database;
  conversations: ConversationRepository;
  messages: MessageRepository;
  usage: UsageRepository;
  agents: AgentRepository;
  connections: ConnectionRepository;
  /** The run's key, read per request (ConnectionService.secretFor); throws secret_missing. */
  secretFor(connection: Connection): Promise<string | undefined>;
  runner: RunnerPort;
  title: TitleService;
  /** The agent's MCP servers, resolved for a run (secrets included). */
  toolServers: Pick<ToolServerService, 'launchesFor'>;
  approvals: ToolApprovalRepository;
  /** Turns attachment file sources into base64 before a run (ADR 0012). */
  attachments: Pick<AttachmentService, 'resolve'>;
  /** `<userData>/workspaces`: default working directory of CLI harness conversations. */
  workspacesDir: string;
  timing?: { uiFlushMs?: number; dbFlushMs?: number; cancelGraceMs?: number };
}

/**
 * Personal conversations (this machine only) and their runs. Runs go through
 * the shared RunEngine; this service persists to SQLite and emits to the
 * window through LocalChatStore. Workspace conversations use the same engine
 * with the hub's store (hub/HubRunService).
 *
 * Streaming: text deltas are coalesced to the UI at most once per frame
 * (16 ms) and checkpointed to SQLite about every 250 ms; the final state,
 * the usage record and the conversation status are written in one
 * transaction on the run's terminal event. Events go out as
 * `message.updated` snapshots plus `message.delta` / `message.block`, all
 * numbered by one `rev` per conversation, so a list fetched mid-stream lines
 * up with the stream (ADR 0008).
 *
 * Tools: the reply keeps its tool_use and tool_result blocks in order (the
 * runner splits them into provider turns). A `run.tool_call` that needs
 * approval puts the conversation in `awaiting-approval` with a pending
 * approval; `decide` records the answer and sends `run.approval`.
 */
export class ConversationService extends EventEmitter<ConversationEvents> {
  private readonly store: LocalChatStore;
  private readonly engine: RunEngine;

  constructor(private readonly deps: ConversationServiceDeps) {
    super();
    this.store = new LocalChatStore({
      ...deps,
      emit: (channel, payload) =>
        (this.emit as (channel: string, payload: unknown) => boolean)(channel, payload),
      pendingOf: (id) => this.engine.pendingOf(id),
      ...(deps.timing ? { timing: deps.timing } : {}),
    });
    this.engine = new RunEngine({
      store: this.store,
      runner: deps.runner,
      secretFor: deps.secretFor,
      title: deps.title,
      workspacesDir: deps.workspacesDir,
      ...(deps.timing?.cancelGraceMs !== undefined
        ? { cancelGraceMs: deps.timing.cancelGraceMs }
        : {}),
      log: (m) => console.error(`ConversationService: ${m}`),
    });
  }

  // ------------------------------------------------------------ conversations

  list(filter: { agentId?: string | undefined; archived: boolean }): ConversationSummary[] {
    return this.deps.conversations.list(filter).map((s) => ({
      ...s,
      pendingApproval: this.engine.pendingOf(s.conversation.id),
    }));
  }

  create(agentId: string): Conversation {
    this.deps.agents.require(agentId);
    return this.deps.conversations.create(agentId);
  }

  rename(id: string, title: string): Conversation {
    return this.store.updated(this.deps.conversations.rename(id, title));
  }

  archive(id: string, archived: boolean): Conversation {
    return this.store.updated(this.deps.conversations.setArchived(id, archived));
  }

  markRead(id: string): void {
    this.deps.conversations.markRead(id);
  }

  /** At boot: whatever was streaming when the app last stopped ends in `error { interrupted }`. */
  recover(): void {
    this.deps.db.transaction(() => {
      this.deps.messages.recoverInterrupted();
      this.deps.conversations.recoverInterrupted();
    });
  }

  // ----------------------------------------------------------------- messages

  /**
   * A page of messages at the conversation's current `rev`. For a
   * conversation streaming right now, pending text is flushed first and the
   * reply carries its live content, so the page is exactly the state at `rev`.
   */
  listMessages(input: {
    conversationId: string;
    beforeSeq?: number | undefined;
    limit: number;
  }): MessagePage {
    const { conversationId } = input;
    this.deps.conversations.require(conversationId);
    const page = this.deps.messages.page(conversationId, input);
    const run = this.engine.liveRun(conversationId);
    if (run) run.session.flush();
    return {
      hasMore: page.hasMore,
      messages: run
        ? page.messages.map((m) =>
            m.id === run.messageId ? { ...m, status: 'streaming', content: [...run.blocks] } : m,
          )
        : page.messages,
      rev: this.store.rev(conversationId),
    };
  }

  /**
   * Persists the user message and an empty reply, then starts the run.
   * Refusals (busy, connection disabled, no model, no key) throw before
   * anything is written; run failures end the reply in `error`.
   */
  sendMessage(conversationId: string, content: UserContent): Promise<void> {
    return this.engine.send(conversationId, content);
  }

  /** Runs the last reply again when it ended in `error`, in the same message. */
  retryLast(conversationId: string): Promise<void> {
    return this.engine.retry(conversationId);
  }

  /** Asks the runner to cancel (a no-op when nothing is running); see RunEngine.cancel. */
  cancel(conversationId: string): void {
    this.engine.cancel(conversationId);
  }

  decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): void {
    this.engine.decide(conversationId, toolUseId, decision);
  }

  /** Before an agent (and, by cascade, its conversations) is deleted: stop its runs, write nothing. */
  forgetAgent(agentId: string): void {
    this.engine.forgetAgent(agentId);
  }

  /** Before quitting: every active run is cancelled and finalized as `cancelled` now. */
  shutdown(): void {
    this.engine.shutdown();
  }

  /** For tests: the live state of a conversation's run. */
  liveRunId(conversationId: string): string | undefined {
    return this.engine.liveRunId(conversationId);
  }
}
