import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  AppError,
  Message,
  type AppErrorShape,
  type Block,
  type MessageRole,
  type MessageStatus,
} from '@comitiva/contract';
import type { Database } from '../Database';
import { messages } from '../schema';

type Row = typeof messages.$inferSelect;

/**
 * Messages in SQLite, ordered by a per-conversation `seq`. Content is the
 * canonical Block[] (ADR 0004), validated by zod on write and on read.
 */
export class MessageRepository {
  constructor(private readonly db: Database) {}

  /** The latest `limit` messages (or those before `beforeSeq`), oldest first. */
  page(
    conversationId: string,
    opts: { beforeSeq?: number | undefined; limit: number },
  ): { messages: Message[]; hasMore: boolean } {
    const rows = this.db.orm
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          opts.beforeSeq !== undefined ? lt(messages.seq, opts.beforeSeq) : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(opts.limit + 1)
      .all();
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map(toMessage), hasMore };
  }

  /** Every message of a conversation, oldest first (the history a run gets). */
  all(conversationId: string): Message[] {
    return this.db.orm
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.seq))
      .all()
      .map(toMessage);
  }

  last(conversationId: string): Message | null {
    const row = this.db.orm
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get();
    return row ? toMessage(row) : null;
  }

  get(id: string): Message | null {
    const row = this.db.orm.select().from(messages).where(eq(messages.id, id)).get();
    return row ? toMessage(row) : null;
  }

  require(id: string): Message {
    const message = this.get(id);
    if (!message) throw new AppError('not_found', `Message ${id} does not exist`);
    return message;
  }

  /** Appends a message with the next seq. Call inside a transaction with related writes. */
  insert(
    conversationId: string,
    role: MessageRole,
    content: Block[],
    status: MessageStatus,
    at = new Date().toISOString(),
  ): Message {
    const { next } = this.db.orm
      .select({ next: sql<number>`coalesce(max(${messages.seq}), -1) + 1` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get()!;
    const message = Message.parse({
      id: ulid(),
      conversationId,
      role,
      content,
      status,
      seq: next,
      createdAt: at,
      error: null,
    });
    this.db.orm.insert(messages).values(message).run();
    return message;
  }

  /** Streaming checkpoint: the content so far. */
  setContent(id: string, content: Block[]): void {
    this.set(id, { content: parseContent(content) });
  }

  /** Final state of a reply. */
  finish(
    id: string,
    status: MessageStatus,
    content: Block[],
    error: AppErrorShape | null,
  ): Message {
    this.set(id, { status, content: parseContent(content), error });
    return this.require(id);
  }

  /** A reply about to be run again (retry): empty, streaming, no error. */
  reset(id: string): Message {
    this.set(id, { status: 'streaming', content: [], error: null });
    return this.require(id);
  }

  /** After a crash or a quit mid-run: streaming replies end in `error { interrupted }`. */
  recoverInterrupted(): void {
    const error: AppErrorShape = {
      code: 'interrupted',
      message: 'The app closed while this reply was streaming',
      retryable: true,
    };
    this.db.orm
      .update(messages)
      .set({ status: 'error', error })
      .where(eq(messages.status, 'streaming'))
      .run();
  }

  /**
   * Stored attachment names that messages refer to (file sources), for every
   * conversation or only an agent's.
   */
  attachmentNames(agentId?: string): Set<string> {
    const rows = this.db.raw
      .prepare(
        `SELECT DISTINCT json_extract(b.value, '$.source.path') AS path
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           , json_each(m.content) b
          WHERE json_extract(b.value, '$.source.kind') = 'file'
            AND (@agentId IS NULL OR c.agent_id = @agentId)`,
      )
      .all({ agentId: agentId ?? null }) as Array<{ path: string | null }>;
    return new Set(rows.flatMap((r) => (r.path ? [r.path] : [])));
  }

  private set(id: string, values: Partial<Row>): void {
    const result = this.db.orm.update(messages).set(values).where(eq(messages.id, id)).run();
    if (result.changes === 0) throw new AppError('not_found', `Message ${id} does not exist`);
  }
}

function parseContent(content: Block[]): Block[] {
  return Message.shape.content.parse(content);
}

function toMessage(row: Row): Message {
  return Message.parse({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    status: row.status,
    seq: row.seq,
    createdAt: row.createdAt,
    error: row.error ?? null,
  });
}
