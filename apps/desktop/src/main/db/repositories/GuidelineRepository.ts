import { asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  AppError,
  Guideline,
  type ValidGuidelineDraft,
  type ValidGuidelinePatch,
} from '@comitiva/contract';
import type { Database } from '../Database';
import { guidelines } from '../schema';

type Row = typeof guidelines.$inferSelect;

/**
 * Guidelines in SQLite, in prompt order (`position`, kept dense from 0).
 * Agents' picks live in `agent_guidelines` (AgentRepository) and go with a
 * deleted guideline.
 */
export class GuidelineRepository {
  constructor(private readonly db: Database) {}

  list(): Guideline[] {
    return this.db.orm
      .select()
      .from(guidelines)
      .orderBy(asc(guidelines.position), asc(guidelines.createdAt), asc(guidelines.id))
      .all()
      .map(toGuideline);
  }

  get(id: string): Guideline | null {
    const row = this.db.orm.select().from(guidelines).where(eq(guidelines.id, id)).get();
    return row ? toGuideline(row) : null;
  }

  require(id: string): Guideline {
    const guideline = this.get(id);
    if (!guideline) throw new AppError('not_found', `Guideline ${id} does not exist`);
    return guideline;
  }

  /** Adds guidelines at the end of the order, in one transaction. */
  createMany(drafts: readonly ValidGuidelineDraft[]): Guideline[] {
    return this.db.transaction(() => {
      let position = this.list().length;
      return drafts.map((draft) => {
        const now = new Date().toISOString();
        const guideline = validate({
          ...draft,
          id: ulid(),
          position: position++,
          createdAt: now,
          updatedAt: now,
        });
        this.db.orm.insert(guidelines).values(guideline).run();
        return guideline;
      });
    });
  }

  create(draft: ValidGuidelineDraft): Guideline {
    return this.createMany([draft])[0]!;
  }

  update(id: string, patch: ValidGuidelinePatch): Guideline {
    const current = this.require(id);
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as ValidGuidelinePatch;
    const guideline = validate({ ...current, ...defined, updatedAt: new Date().toISOString() });
    this.db.orm.update(guidelines).set(guideline).where(eq(guidelines.id, id)).run();
    return guideline;
  }

  /** Deletes it (agents' picks cascade) and closes the gap in the order. */
  delete(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.orm.delete(guidelines).where(eq(guidelines.id, id)).run();
      this.renumber(this.list().map((g) => g.id));
    });
  }

  /** Moves a guideline to `index` (clamped to the end); returns the new order. */
  move(id: string, index: number): Guideline[] {
    this.require(id);
    return this.db.transaction(() => {
      const ids = this.list()
        .map((g) => g.id)
        .filter((g) => g !== id);
      ids.splice(Math.min(index, ids.length), 0, id);
      this.renumber(ids);
      return this.list();
    });
  }

  private renumber(ids: readonly string[]): void {
    ids.forEach((id, position) => {
      this.db.orm.update(guidelines).set({ position }).where(eq(guidelines.id, id)).run();
    });
  }
}

function validate(candidate: unknown): Guideline {
  const parsed = Guideline.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('invalid_request', `Invalid guideline: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

function toGuideline(row: Row): Guideline {
  return Guideline.parse(row);
}
