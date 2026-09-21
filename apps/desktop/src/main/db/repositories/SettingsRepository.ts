import { AppSettings, type AppSettingsPatch } from '@comitiva/contract';
import type { Database } from '../Database';
import { appSettings } from '../schema';

/** App-wide preferences, one row per key; missing keys take their defaults. */
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(): AppSettings {
    const rows = this.db.orm.select().from(appSettings).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // A value that no longer validates falls back to its default instead of failing the app.
    const parsed = AppSettings.safeParse(stored);
    return parsed.success ? parsed.data : AppSettings.parse({});
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
