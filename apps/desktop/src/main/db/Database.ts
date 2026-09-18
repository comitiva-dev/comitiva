import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Orm = BetterSQLite3Database<typeof schema>;

/** The desktop's local SQLite database. Secrets never go here (ADR 0003). */
export class Database {
  private constructor(
    readonly raw: BetterSqlite3.Database,
    readonly orm: Orm,
  ) {}

  /** Opens (or creates) the database with WAL, foreign keys and a busy timeout. */
  static open(path: string): Database {
    const raw = new BetterSqlite3(path);
    if (path !== ':memory:') raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    return new Database(raw, drizzle(raw, { schema }));
  }

  /** Applies pending migrations from the generated folder, in order. Idempotent. */
  migrate(migrationsFolder: string): void {
    migrate(this.orm, { migrationsFolder });
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.raw.close();
  }
}
