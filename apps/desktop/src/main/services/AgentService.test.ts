import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/Database';
import { AgentRepository } from '../db/repositories/AgentRepository';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import { AgentService } from './AgentService';

let db: Database;
let service: AgentService;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'db', 'migrations'));
  new ConnectionRepository(db).create({
    id: 'c1',
    name: 'Anthropic',
    provider: 'anthropic',
    config: { defaultModel: 'claude-haiku-4-5' },
    secretRef: null,
  });
  service = new AgentService(new AgentRepository(db));
});
afterEach(() => db.close());

describe('AgentService', () => {
  it('names a duplicate with the given name, else "<name> (copy)"', () => {
    const agent = service.create({
      name: 'Writer',
      avatar: { color: 'indigo' },
      connectionId: 'c1',
      model: null,
      role: '',
      params: {},
      tags: [],
      toolServerIds: [],
      roots: [],
      permissionPolicy: 'ask',
    });
    expect(service.duplicate(agent.id, 'Writer (cópia)').name).toBe('Writer (cópia)');
    expect(service.duplicate(agent.id).name).toBe('Writer (copy)');
    expect(service.list()).toHaveLength(3);
  });
});
