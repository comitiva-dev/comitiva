import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { UsageRecord } from '@comitiva/contract';
import type { Database } from '../Database';
import { usageRecords } from '../schema';

export type NewUsageRecord = Omit<UsageRecord, 'id' | 'createdAt'> & { createdAt?: string };

/** Token usage, one record per run (replies and titles). Reports come in Phase 6. */
export class UsageRepository {
  constructor(private readonly db: Database) {}

  insert(data: NewUsageRecord): UsageRecord {
    const record = UsageRecord.parse({
      ...data,
      id: ulid(),
      createdAt: data.createdAt ?? new Date().toISOString(),
    });
    const { estimatedCostUsd, ...columns } = record;
    this.db.orm
      .insert(usageRecords)
      .values({ ...columns, costUsd: estimatedCostUsd })
      .run();
    return record;
  }

  listByConversation(conversationId: string): UsageRecord[] {
    return this.db.orm
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.conversationId, conversationId))
      .all()
      .map(({ costUsd, ...row }) => UsageRecord.parse({ ...row, estimatedCostUsd: costUsd }));
  }
}
