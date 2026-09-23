import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/Database';
import { AgentRepository } from '../db/repositories/AgentRepository';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import { ConversationRepository } from '../db/repositories/ConversationRepository';
import { MessageRepository } from '../db/repositories/MessageRepository';
import { ToolServerRepository } from '../db/repositories/ToolServerRepository';
import { BundleService } from './BundleService';
import { ExportService, fileSlug } from './ExportService';

let dir: string;
let db: Database;
let saved: string | null;
let opened: string | null;
let service: ExportService;
let conversations: ConversationRepository;
let messages: MessageRepository;
let agents: AgentRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comitiva-export-'));
  db = Database.open(':memory:');
  db.migrate(join(__dirname, '..', 'db', 'migrations'));
  const connections = new ConnectionRepository(db);
  const toolServers = new ToolServerRepository(db);
  agents = new AgentRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  connections.create({
    id: 'c1',
    name: 'Claude',
    provider: 'anthropic',
    config: { defaultModel: 'claude-sonnet-5' },
    secretRef: 'connection:c1',
  });
  agents.create({
    id: 'a1',
    name: 'Planner',
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
  saved = join(dir, 'out.file');
  opened = null;
  service = new ExportService({
    conversations,
    messages,
    agents,
    connections,
    bundle: new BundleService({ db, connections, toolServers, agents, appVersion: '0.1.0' }),
    saveFile: async () => saved,
    openFile: async () => opened,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ExportService', () => {
  it('writes a conversation as Markdown with the agent and model', async () => {
    const c = conversations.create('a1');
    conversations.rename(c.id, 'Launch plan');
    messages.insert(c.id, 'user', [{ type: 'text', text: 'Hello' }], 'complete');
    expect(await service.conversationMarkdown(c.id)).toBe(saved);
    const md = readFileSync(saved!, 'utf8');
    expect(md).toContain('# Launch plan');
    expect(md).toContain('- Model: Anthropic · claude-sonnet-5');
    expect(md).toContain('Hello');
  });

  it('writes nothing when the dialog is cancelled', async () => {
    saved = null;
    const c = conversations.create('a1');
    expect(await service.conversationMarkdown(c.id)).toBeNull();
    expect(await service.exportBundle()).toBeNull();
  });

  it('round-trips a bundle through a file', async () => {
    await service.exportBundle();
    const bundle = JSON.parse(readFileSync(saved!, 'utf8'));
    expect(bundle).toMatchObject({ format: 'comitiva.bundle', version: 1 });
    opened = saved;
    const report = await service.importBundle();
    expect(report).toMatchObject({ connections: 1, agents: 1 });
    expect(agents.list().map((a) => a.name)).toEqual(['Planner', 'Planner']);
    opened = null;
    expect(await service.importBundle()).toBeNull();
    writeFileSync(join(dir, 'bad.json'), '{"format":"x"}');
    opened = join(dir, 'bad.json');
    await expect(service.importBundle()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('makes file names from titles', () => {
    expect(fileSlug('Relatório: Q3 / final!')).toBe('relatorio-q3-final');
    expect(fileSlug('***')).toBe('conversation');
  });
});
