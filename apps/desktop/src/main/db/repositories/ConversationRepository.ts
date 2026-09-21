import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  AppError,
  Conversation,
  type ConversationStatus,
  type ConversationSummary,
} from '@comitiva/contract';
import type { Database } from '../Database';
import { conversations } from '../schema';

type Row = typeof conversations.$inferSelect;

/**
 * Conversations in SQLite. Besides the contract entity, each row keeps the
 * connection its harness session belongs to and how far the user has read
 * (both local to this desktop, never on the entity).
 */
export class ConversationRepository {
  constructor(private readonly db: Database) {}

  /** Newest activity first, with unread replies (assistant messages past `last_read_seq`). */
  list(filter: { agentId?: string | undefined; archived: boolean }): ConversationSummary[] {
    // Drizzle leaves columns unqualified inside sql``, so the correlated subquery is spelled out.
    const unread = sql<number>`(
      SELECT count(*) FROM messages m
      WHERE m.conversation_id = conversations.id
        AND m.role = 'assistant'
        AND m.status IN ('complete', 'cancelled', 'error')
        AND m.seq > conversations.last_read_seq
    )`;
    const rows = this.db.orm
      .select({ row: conversations, unread })
      .from(conversations)
      .where(
        and(
          eq(conversations.archived, filter.archived),
          filter.agentId !== undefined ? eq(conversations.agentId, filter.agentId) : undefined,
        ),
      )
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
      .all();
    return rows.map(({ row, unread }) => ({
      conversation: toConversation(row),
      unread,
      pendingApproval: null,
    }));
  }

  get(id: string): Conversation | null {
    const row = this.row(id);
    return row ? toConversation(row) : null;
  }

  /** Like `get`, but throws `not_found`. */
  require(id: string): Conversation {
    const conversation = this.get(id);
    if (!conversation) throw new AppError('not_found', `Conversation ${id} does not exist`);
    return conversation;
  }

  /** The harness session to resume, only when it belongs to `connectionId`. */
  harnessSession(id: string, connectionId: string): string | undefined {
    const row = this.row(id);
    if (!row?.harnessSessionId || row.harnessConnectionId !== connectionId) return undefined;
    return row.harnessSessionId;
  }

  create(agentId: string, at = new Date().toISOString()): Conversation {
    const id = ulid();
    this.db.orm
      .insert(conversations)
      .values({ id, agentId, title: null, status: 'idle', lastActivityAt: at, createdAt: at })
      .run();
    return this.require(id);
  }

  rename(id: string, title: string | null): Conversation {
    return this.patch(id, { title });
  }

  setArchived(id: string, archived: boolean): Conversation {
    return this.patch(id, { archived });
  }

  setStatus(id: string, status: ConversationStatus): Conversation {
    return this.patch(id, { status });
  }

  touch(id: string, at = new Date().toISOString()): Conversation {
    return this.patch(id, { lastActivityAt: at });
  }

  setHarnessSession(id: string, sessionId: string, connectionId: string): void {
    this.patch(id, { harnessSessionId: sessionId, harnessConnectionId: connectionId });
  }

  /** Everything up to the latest message counts as read. */
  markRead(id: string): void {
    this.require(id);
    this.db.orm
      .update(conversations)
      .set({
        lastReadSeq: sql`coalesce((SELECT max(m.seq) FROM messages m WHERE m.conversation_id = ${id}), 0)`,
      })
      .where(eq(conversations.id, id))
      .run();
  }

  /**
   * After a crash or a quit mid-run: conversations left running (or waiting
   * for an approval) end in `error`. Returns their ids.
   */
  recoverInterrupted(): string[] {
    const stuck = this.db.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.status, ['running', 'awaiting-approval']))
      .all()
      .map((r) => r.id);
    if (stuck.length > 0) {
      this.db.orm
        .update(conversations)
        .set({ status: 'error' })
        .where(inArray(conversations.id, stuck))
        .run();
    }
    return stuck;
  }

  private row(id: string): Row | undefined {
    return this.db.orm.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  private patch(id: string, set: Partial<Row>): Conversation {
    const result = this.db.orm.update(conversations).set(set).where(eq(conversations.id, id)).run();
    if (result.changes === 0) throw new AppError('not_found', `Conversation ${id} does not exist`);
    return this.require(id);
  }
}

function toConversation(row: Row): Conversation {
  return Conversation.parse({
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    status: row.status,
    harnessSessionId: row.harnessSessionId,
    archived: row.archived,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
  });
}
