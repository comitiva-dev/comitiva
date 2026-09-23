import { AppSettings, type AppSettingsPatch } from '@comitiva/contract';
import type { Database } from '../Database';
import { appSettings } from '../schema';

/** App-wide preferences, one row per key; missing keys take their defaults. */
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(): AppSettings {
    const rows = this.db.orm.select().from(appSettings).all();
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    // Key by key: a value that no longer validates falls back to its default
    // instead of failing the app or resetting the other preferences.
    const valid = Object.fromEntries(
      Object.entries(AppSettings.shape).flatMap(([key, schema]) => {
        const parsed = schema.safeParse(stored.get(key));
        return parsed.success && stored.has(key) ? [[key, parsed.data]] : [];
      }),
    );
    return AppSettings.parse(valid);
  }

  update(patch: AppSettingsPatch): AppSettings {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        this.db.orm
          .insert(appSettings)
          .values({ key, value })
          .onConflictDoUpdate({ target: appSettings.key, set: { value } })
          .run();
      }
    });
    return this.get();
  }
}
