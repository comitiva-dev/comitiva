import { eq } from 'drizzle-orm';
import { HubUser } from '@comitiva/contract';
import type { HubSettings } from '../../hub/HubService';
import type { Database } from '../Database';
import { appSettings } from '../schema';

const URL_KEY = 'hub.url';
const USER_KEY = 'hub.user';

/**
 * The hub's address and who is signed in, kept next to the app settings (the
 * token itself is in the SecretStore). A value that no longer validates is
 * forgotten rather than trusted.
 */
export class HubSettingsRepository {
  constructor(private readonly db: Database) {}

  get(): HubSettings {
    const read = (key: string) =>
      this.db.orm.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value;
    const url = read(URL_KEY);
    const user = HubUser.safeParse(read(USER_KEY));
    return {
      url: typeof url === 'string' ? url : null,
      user: user.success ? user.data : null,
    };
  }

  set(settings: HubSettings): void {
    this.db.transaction(() => {
      for (const [key, value] of [
        [URL_KEY, settings.url],
        [USER_KEY, settings.user],
      ] as const) {
        if (value === null) {
          this.db.orm.delete(appSettings).where(eq(appSettings.key, key)).run();
        } else {
          this.db.orm
            .insert(appSettings)
            .values({ key, value })
            .onConflictDoUpdate({ target: appSettings.key, set: { value } })
            .run();
        }
      }
    });
  }
}
