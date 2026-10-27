import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../Database';
import { AgentRepository } from './AgentRepository';
import { ConnectionRepository } from './ConnectionRepository';
import { GuidelineRepository } from './GuidelineRepository';

let db: Database;
let repo: GuidelineRepository;
let agents: AgentRepository;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'migrations'));
  repo = new GuidelineRepository(db);
  agents = new AgentRepository(db);
  new ConnectionRepository(db).create({
    id: 'c1',
    name: 'Anthropic',
    provider: 'anthropic',
    config: { defaultModel: 'claude-sonnet-5' },
    secretRef: null,
  });
});
afterEach(() => db.close());

const draft = (name: string) => ({
  name,
  content: `${name} text`,
  scope: 'agents' as const,
  agentTags: [],
});
const names = () => repo.list().map((g) => g.name);

describe('GuidelineRepository', () => {
  it('adds guidelines at the end of the order and validates them', () => {
    const [a, b] = repo.createMany([draft('A'), draft('B')]);
    const c = repo.create(draft('C'));
    expect([a!.position, b!.position, c.position]).toEqual([0, 1, 2]);
    expect(repo.require(c.id)).toEqual(c);
    expect(() => repo.update(c.id, { name: '' })).toThrow(/Invalid guideline/);
    expect(() => repo.require('nope')).toThrow(/does not exist/);
  });

  it('updates only the fields given', () => {
    const g = repo.create(draft('A'));
    const updated = repo.update(g.id, { scope: 'tags', agentTags: ['research'] });
    expect(updated).toMatchObject({
      name: 'A',
      content: 'A text',
      scope: 'tags',
      agentTags: ['research'],
    });
    expect(repo.get(g.id)).toEqual(updated);
  });

  it('moves a guideline and keeps positions dense', () => {
    const [a, , c] = repo.createMany([draft('A'), draft('B'), draft('C')]);
    expect(repo.move(c!.id, 0).map((g) => g.name)).toEqual(['C', 'A', 'B']);
    expect(repo.move(c!.id, 99).map((g) => g.position)).toEqual([0, 1, 2]);
    expect(names()).toEqual(['A', 'B', 'C']);
    repo.delete(a!.id);
    expect(repo.list().map((g) => [g.name, g.position])).toEqual([
      ['B', 0],
      ['C', 1],
    ]);
  });

  it('keeps agents’ picks, rejects unknown ones and drops them with the guideline', () => {
    const g = repo.create(draft('A'));
    const agent = agents.create({
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
      guidelineIds: [g.id],
    });
    expect(agents.require(agent.id).guidelineIds).toEqual([g.id]);
    expect(agents.list()[0]!.guidelineIds).toEqual([g.id]);
    expect(agents.duplicate(agent.id, 'Copy').guidelineIds).toEqual([g.id]);
    expect(() => agents.update(agent.id, { guidelineIds: ['missing'] })).toThrow(
      /Unknown tool server or guideline/,
    );
    expect(() => agents.update(agent.id, { guidelineIds: [g.id, g.id] })).toThrow(/listed twice/);
    repo.delete(g.id);
    expect(agents.require(agent.id).guidelineIds).toEqual([]);
  });
});
