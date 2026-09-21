import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidAgentDraft } from '@comitiva/contract';
import { Database } from '../Database';
import { toolServers } from '../schema';
import { AgentRepository } from './AgentRepository';
import { ConnectionRepository } from './ConnectionRepository';

const migrations = join(__dirname, '..', 'migrations');
let db: Database;
let repo: AgentRepository;
let connections: ConnectionRepository;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  repo = new AgentRepository(db);
  connections = new ConnectionRepository(db);
  // An API connection with a default model, one without, and a CLI harness.
  connections.create({
    id: 'c-api',
    name: 'Anthropic',
    provider: 'anthropic',
    config: { defaultModel: 'claude-haiku-4-5' },
    secretRef: null,
  });
  connections.create({
    id: 'c-nomodel',
    name: 'Ollama',
    provider: 'ollama',
    config: {},
    secretRef: null,
  });
  connections.create({
    id: 'c-cli',
    name: 'Claude Code',
    provider: 'claude-code',
    config: {},
    secretRef: null,
  });
});
afterEach(() => db.close());

const draft = (overrides: Partial<ValidAgentDraft> = {}): ValidAgentDraft => ({
  name: 'Writer',
  avatar: { color: 'emerald', emoji: '✍️' },
  connectionId: 'c-api',
  model: null,
  role: 'You write clearly.',
  params: { temperature: 0.7, maxTokens: 2048 },
  tags: ['writing', 'docs'],
  toolServerIds: [],
  roots: [],
  permissionPolicy: 'ask',
  ...overrides,
});

const addToolServer = (id: string) =>
  db.orm
    .insert(toolServers)
    .values({ id, name: id, transport: 'stdio', command: 'x', createdAt: new Date().toISOString() })
    .run();

describe('AgentRepository', () => {
  it('creates, lists and gets agents with every field', () => {
    const a = repo.create({ ...draft(), id: '01A' });
    const b = repo.create({
      ...draft({ name: 'Reviewer', avatar: { color: 'slate' } }),
      id: '01B',
    });
    expect(a).toMatchObject({
      id: '01A',
      name: 'Writer',
      avatar: { color: 'emerald', emoji: '✍️' },
      model: null,
      params: { temperature: 0.7, maxTokens: 2048 },
      tags: ['writing', 'docs'],
      fallbackConnectionIds: [],
    });
    expect(b.avatar).toEqual({ color: 'slate' });
    expect(repo.list().map((x) => x.id)).toEqual(['01A', '01B']);
    expect(repo.get('01A')).toEqual(a);
    expect(repo.get('missing')).toBeNull();
    expect(() => repo.require('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('saves, loads and replaces roots and tool servers together', () => {
    addToolServer('ts1');
    addToolServer('ts2');
    const a = repo.create(
      draft({
        roots: [
          { path: '/data/reports', mode: 'read' },
          { path: '/data/out', mode: 'readwrite' },
        ],
        toolServerIds: ['ts1'],
      }),
    );
    expect(repo.get(a.id)).toMatchObject({
      roots: [
        { path: '/data/reports', mode: 'read' },
        { path: '/data/out', mode: 'readwrite' },
      ],
      toolServerIds: ['ts1'],
    });

    repo.update(a.id, { roots: [{ path: '/data/new', mode: 'read' }], toolServerIds: ['ts2'] });
    expect(repo.list()[0]).toMatchObject({
      roots: [{ path: '/data/new', mode: 'read' }],
      toolServerIds: ['ts2'],
    });

    // Other changes keep the links.
    repo.update(a.id, { name: 'Renamed' });
    expect(repo.get(a.id)?.toolServerIds).toEqual(['ts2']);
  });

  it('rejects unknown tool servers and duplicate roots without writing', () => {
    expect(() => repo.create(draft({ toolServerIds: ['nope'] }))).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() =>
      repo.create(
        draft({
          roots: [
            { path: '/a', mode: 'read' },
            { path: '/a', mode: 'readwrite' },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(repo.list()).toEqual([]);
  });

  it('cascades roots and tool server links on delete', () => {
    addToolServer('ts1');
    const a = repo.create(draft({ roots: [{ path: '/a', mode: 'read' }], toolServerIds: ['ts1'] }));
    repo.delete(a.id);
    expect(repo.get(a.id)).toBeNull();
    expect(db.raw.prepare('SELECT count(*) AS n FROM agent_roots').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT count(*) AS n FROM agent_tool_servers').get()).toEqual({ n: 0 });
    expect(() => repo.delete(a.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  describe('validation', () => {
    it('requires an existing connection', () => {
      expect(() => repo.create(draft({ connectionId: 'missing' }))).toThrow(
        expect.objectContaining({ code: 'not_found' }),
      );
    });

    it('requires an enabled connection', () => {
      connections.update('c-api', { enabled: false });
      expect(() => repo.create(draft())).toThrow(
        expect.objectContaining({ code: 'connection_disabled' }),
      );
    });

    it('requires a model for an API connection without a default', () => {
      expect(() => repo.create(draft({ connectionId: 'c-nomodel' }))).toThrow(
        expect.objectContaining({ code: 'model_required' }),
      );
      expect(repo.create(draft({ connectionId: 'c-nomodel', model: 'llama3.2' })).model).toBe(
        'llama3.2',
      );
      // The connection's default, or a harness's own default, is enough.
      expect(repo.create(draft({ connectionId: 'c-api' })).model).toBeNull();
      expect(repo.create(draft({ connectionId: 'c-cli' })).model).toBeNull();
    });

    it('checks again when the connection or model change', () => {
      const a = repo.create(draft());
      expect(() => repo.update(a.id, { connectionId: 'c-nomodel' })).toThrow(
        expect.objectContaining({ code: 'model_required' }),
      );
      const b = repo.create(draft({ connectionId: 'c-nomodel', model: 'llama3.2' }));
      expect(() => repo.update(b.id, { model: null })).toThrow(
        expect.objectContaining({ code: 'model_required' }),
      );
      expect(repo.update(a.id, { connectionId: 'c-cli' }).connectionId).toBe('c-cli');
    });

    it('still edits an agent whose connection was disabled later', () => {
      const a = repo.create(draft());
      connections.update('c-api', { enabled: false });
      const updated = repo.update(a.id, { name: 'Renamed', role: 'New role' });
      expect(updated).toMatchObject({ name: 'Renamed', role: 'New role', connectionId: 'c-api' });
      expect(() => repo.update(a.id, { model: 'claude-sonnet' })).toThrow(
        expect.objectContaining({ code: 'connection_disabled' }),
      );
    });

    it('rejects invalid fields', () => {
      expect(() => repo.create(draft({ name: '' }))).toThrow(
        expect.objectContaining({ code: 'invalid_request' }),
      );
      const a = repo.create(draft());
      expect(() => repo.update(a.id, { params: { temperature: 5 } })).toThrow(
        expect.objectContaining({ code: 'invalid_request' }),
      );
      expect(repo.get(a.id)?.params).toEqual({ temperature: 0.7, maxTokens: 2048 });
    });
  });

  it('duplicates everything under a new id, name and timestamps', () => {
    addToolServer('ts1');
    const a = repo.create(draft({ roots: [{ path: '/a', mode: 'read' }], toolServerIds: ['ts1'] }));
    const copy = repo.duplicate(a.id, 'Writer (copy)');
    expect(copy.id).not.toBe(a.id);
    const { id: _a, name: _b, createdAt: _c, updatedAt: _d, ...same } = a;
    expect(copy).toMatchObject({ ...same, name: 'Writer (copy)' });
    expect(repo.list()).toHaveLength(2);
  });

  it('keeps the connection from being deleted while agents use it', () => {
    repo.create(draft({ name: 'Writer' }));
    repo.create(draft({ name: 'Editor' }));
    expect(() => connections.delete('c-api')).toThrow(
      expect.objectContaining({
        code: 'connection_in_use',
        message: 'Connection Anthropic is used by: Editor, Writer',
      }),
    );
  });
});
