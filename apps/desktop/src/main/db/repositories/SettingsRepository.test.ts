import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../Database';
import { appSettings } from '../schema';
import { SettingsRepository } from './SettingsRepository';

let db: Database;
let repo: SettingsRepository;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'migrations'));
  repo = new SettingsRepository(db);
});
afterEach(() => db.close());

describe('SettingsRepository', () => {
  it('returns defaults, then stored values', () => {
    expect(repo.get()).toEqual({ sampleAgentOffer: 'pending' });
    expect(repo.update({ sampleAgentOffer: 'done' })).toEqual({ sampleAgentOffer: 'done' });
    expect(new SettingsRepository(db).get()).toEqual({ sampleAgentOffer: 'done' });
    expect(repo.update({})).toEqual({ sampleAgentOffer: 'done' });
  });

  it('falls back to defaults when a stored value no longer validates', () => {
    db.orm.insert(appSettings).values({ key: 'sampleAgentOffer', value: 'bogus' }).run();
    expect(repo.get()).toEqual({ sampleAgentOffer: 'pending' });
  });
});
