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
  const defaults = { sampleAgentOffer: 'pending', language: 'system', autoUpdate: true };

  it('returns defaults, then stored values', () => {
    expect(repo.get()).toEqual(defaults);
    expect(repo.update({ sampleAgentOffer: 'done' })).toEqual({
      ...defaults,
      sampleAgentOffer: 'done',
    });
    expect(repo.update({ language: 'pt-BR', autoUpdate: false })).toMatchObject({
      language: 'pt-BR',
      autoUpdate: false,
    });
    expect(new SettingsRepository(db).get()).toEqual({
      sampleAgentOffer: 'done',
      language: 'pt-BR',
      autoUpdate: false,
    });
    expect(repo.update({})).toMatchObject({ sampleAgentOffer: 'done' });
  });

  it('falls back to the default of a stored value that no longer validates, keeping the others', () => {
    repo.update({ language: 'pt-BR' });
    db.orm.insert(appSettings).values({ key: 'sampleAgentOffer', value: 'bogus' }).run();
    expect(repo.get()).toEqual({ ...defaults, language: 'pt-BR' });
  });
});
