import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILESYSTEM_TOOL_SERVER_ID } from '@comitiva/contract';
import { Database } from '../Database';
import { ToolApprovalRepository } from './ToolApprovalRepository';
import { ToolServerRepository } from './ToolServerRepository';

const migrations = join(__dirname, '..', 'migrations');
let db: Database;
let repo: ToolServerRepository;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  repo = new ToolServerRepository(db);
});
afterEach(() => db.close());

const search = {
  id: '01S',
  name: 'Search',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', 'search-mcp'],
  env: { API_KEY: { secretRef: 'toolServer:01S:env:API_KEY' }, REGION: { value: 'eu' } },
  url: null,
  headers: {},
  enabled: true,
};

describe('ToolServerRepository', () => {
  it('ships the built-in filesystem server, enabled, and lists built-ins first', () => {
    repo.create(search);
    const [first, second] = repo.list();
    expect(first).toMatchObject({
      id: FILESYSTEM_TOOL_SERVER_ID,
      builtin: true,
      enabled: true,
      transport: 'stdio',
      command: null,
    });
    expect(second).toMatchObject({ id: '01S', builtin: false });
  });

  it('round-trips env and headers as values or secret refs only', () => {
    expect(repo.create(search)).toEqual(repo.require('01S'));
    const raw = db.raw.prepare('SELECT env FROM tool_servers WHERE id = ?').get('01S') as {
      env: string;
    };
    expect(JSON.parse(raw.env)).toEqual(search.env);
    const http = repo.create({
      ...search,
      id: '01H',
      transport: 'http',
      command: null,
      args: [],
      env: {},
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { secretRef: 'toolServer:01H:header:Authorization' } },
    });
    expect(http.url).toBe('https://mcp.example.com/mcp');
  });

  it('updates, refuses to delete built-ins, and cascades agent links on delete', () => {
    repo.create(search);
    expect(repo.update('01S', { enabled: false, name: 'Web search' })).toMatchObject({
      enabled: false,
      name: 'Web search',
    });
    expect(repo.update(FILESYSTEM_TOOL_SERVER_ID, { enabled: false }).enabled).toBe(false);
    expect(() => repo.delete(FILESYSTEM_TOOL_SERVER_ID)).toThrow(/cannot be deleted/);
    repo.delete('01S');
    expect(repo.get('01S')).toBeNull();
    expect(() => repo.require('01S')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('rejects rows the schema does not accept', () => {
    expect(() => repo.create({ ...search, id: '01X', name: '' })).toThrow();
  });
});

describe('ToolApprovalRepository', () => {
  it('records decisions and lists what an agent always allows', () => {
    db.raw.exec(`
      INSERT INTO connections (id, name, kind, provider, config, created_at, updated_at)
        VALUES ('c', 'C', 'api', 'anthropic', '{"defaultModel":"m"}', 'x', 'x');
      INSERT INTO agents (id, name, avatar, connection_id, created_at, updated_at)
        VALUES ('a', 'A', '{"color":"indigo"}', 'c', 'x', 'x');
      INSERT INTO conversations (id, agent_id, last_activity_at, created_at) VALUES ('k', 'a', 'x', 'x');
    `);
    const approvals = new ToolApprovalRepository(db);
    const base = {
      conversationId: 'k',
      agentId: 'a',
      toolServerId: 'filesystem',
      input: { path: '/x' },
    };
    approvals.insert({ ...base, toolUseId: 't1', toolName: 'write_file', decision: 'allow' });
    approvals.insert({ ...base, toolUseId: 't2', toolName: 'move', decision: 'allow-always' });
    approvals.insert({ ...base, toolUseId: 't3', toolName: 'move', decision: 'allow-always' });
    approvals.insert({ ...base, toolUseId: 't4', toolName: 'delete', decision: 'deny' });
    expect(approvals.alwaysAllowed('a')).toEqual(['filesystem:move']);
    expect(approvals.alwaysAllowed('other')).toEqual([]);
    expect(approvals.listByConversation('k').map((r) => r.decision)).toEqual([
      'allow',
      'allow-always',
      'allow-always',
      'deny',
    ]);
  });
});
