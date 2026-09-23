import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError, FILESYSTEM_TOOL_SERVER_ID } from '@comitiva/contract';
import { Database } from '../db/Database';
import { AgentRepository } from '../db/repositories/AgentRepository';
import { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import { ToolServerRepository } from '../db/repositories/ToolServerRepository';
import { BundleService } from './BundleService';

const migrations = join(__dirname, '..', 'db', 'migrations');

function open(exists: (p: string) => boolean = () => true) {
  const db = Database.open(':memory:');
  db.migrate(migrations);
  const repos = {
    connections: new ConnectionRepository(db),
    toolServers: new ToolServerRepository(db),
    agents: new AgentRepository(db),
  };
  const service = new BundleService({
    db,
    ...repos,
    appVersion: '0.1.0',
    exists,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  });
  return { db, ...repos, service };
}

const agentDraft = (name: string, connectionId: string, extra: object = {}) => ({
  name,
  avatar: { color: 'indigo' as const },
  connectionId,
  model: null,
  role: `You are ${name}.`,
  params: { temperature: 0.3 },
  tags: ['team'],
  toolServerIds: [] as string[],
  roots: [] as Array<{ path: string; mode: 'read' | 'readwrite' }>,
  permissionPolicy: 'ask' as const,
  ...extra,
});

let source: ReturnType<typeof open>;

beforeEach(() => {
  source = open();
  source.connections.create({
    id: 'c-claude',
    name: 'Claude',
    provider: 'anthropic',
    config: { defaultModel: 'claude-sonnet-5', baseUrl: 'https://api.anthropic.com' },
    secretRef: 'connection:c-claude',
  });
  source.connections.create({
    id: 'c-local',
    name: 'Local',
    provider: 'ollama',
    config: { baseUrl: 'http://localhost:11434', defaultModel: 'llama3' },
    secretRef: null,
  });
  source.toolServers.create({
    id: 'ts-gh',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'github-mcp'],
    env: {
      GITHUB_TOKEN: { secretRef: 'toolServer:ts-gh:env:GITHUB_TOKEN' },
      LOG: { value: 'info' },
    },
    url: null,
    headers: {},
    enabled: true,
  });
  source.agents.create(
    agentDraft('Researcher', 'c-claude', {
      toolServerIds: ['ts-gh', FILESYSTEM_TOOL_SERVER_ID],
      roots: [{ path: '/home/me/notes', mode: 'read' }],
    }),
  );
  source.agents.create(agentDraft('Local helper', 'c-local'));
});

describe('BundleService.export', () => {
  it('carries agents, what they use, and no secret or secret reference', () => {
    const bundle = source.service.export();
    expect(bundle.connections.map((c) => [c.name, c.hadKey])).toEqual([
      ['Claude', true],
      ['Local', false],
    ]);
    expect(bundle.toolServers[0]!.env).toEqual({
      GITHUB_TOKEN: { secret: true },
      LOG: { value: 'info' },
    });
    expect(bundle.agents[0]!.toolServerRefs).toEqual([bundle.toolServers[0]!.ref, 'filesystem']);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('secretRef');
    expect(text).not.toContain('connection:c-claude');
    expect(text).not.toContain('ts-gh');
  });

  it('exports only the agents asked for', () => {
    const [local] = source.agents.list().filter((a) => a.name === 'Local helper');
    const bundle = source.service.export([local!.id]);
    expect(bundle.agents.map((a) => a.name)).toEqual(['Local helper']);
    expect(bundle.connections.map((c) => c.name)).toEqual(['Local']);
    expect(bundle.toolServers).toEqual([]);
    expect(() => source.service.export(['nope'])).toThrow(AppError);
  });
});

describe('BundleService.import', () => {
  it('recreates the same structure under new ids, and says what needs finishing', () => {
    const json = JSON.stringify(source.service.export());
    const target = open((p) => p !== '/home/me/notes');
    const report = target.service.import(json);
    expect(report).toMatchObject({ connections: 2, toolServers: 1, agents: 2 });
    expect(report.warnings).toEqual([
      { code: 'key_needed', subject: 'Claude', detail: null, error: null },
      { code: 'secret_needed', subject: 'GitHub', detail: 'GITHUB_TOKEN', error: null },
      { code: 'root_missing', subject: 'Researcher', detail: '/home/me/notes', error: null },
    ]);

    const agents = target.agents.list();
    const researcher = agents.find((a) => a.name === 'Researcher')!;
    const { connection } = target.connections.require(researcher.connectionId);
    expect(connection).toMatchObject({ name: 'Claude', secretRef: null });
    expect(connection.id).not.toBe('c-claude');
    expect(researcher).toMatchObject({
      role: 'You are Researcher.',
      params: { temperature: 0.3 },
      tags: ['team'],
      roots: [{ path: '/home/me/notes', mode: 'read' }],
    });
    const gh = target.toolServers.require(
      researcher.toolServerIds.find((id) => id !== 'filesystem')!,
    );
    expect(gh.env.GITHUB_TOKEN).toEqual({ secretRef: `toolServer:${gh.id}:env:GITHUB_TOKEN` });
    expect(researcher.toolServerIds).toContain('filesystem');
  });

  it('skips an agent that cannot be created here, keeping the rest', () => {
    const bundle = source.service.export();
    bundle.connections[1]!.enabled = false; // Local
    const target = open();
    const report = target.service.import(JSON.stringify(bundle));
    expect(report.agents).toBe(1);
    expect(report.warnings).toContainEqual({
      code: 'agent_skipped',
      subject: 'Local helper',
      detail: null,
      error: 'connection_disabled',
    });
  });

  it('flags a harness binary missing on this machine', () => {
    source.connections.create({
      id: 'c-cc',
      name: 'Claude Code',
      provider: 'claude-code',
      config: { binaryPath: '/opt/claude' },
      secretRef: null,
    });
    source.agents.create(agentDraft('Coder', 'c-cc'));
    const target = open((p) => p !== '/opt/claude');
    const report = target.service.import(JSON.stringify(source.service.export()));
    expect(report.warnings).toContainEqual({
      code: 'binary_not_found',
      subject: 'Claude Code',
      detail: '/opt/claude',
      error: null,
    });
  });

  it('refuses what is not a bundle this version reads, writing nothing', () => {
    const target = open();
    const bundle = source.service.export();
    const code = (json: string) => {
      try {
        target.service.import(json);
        return 'none';
      } catch (err) {
        return (err as AppError).code;
      }
    };
    expect(code('not json')).toBe('invalid_request');
    expect(code(JSON.stringify({ ...bundle, version: 2 }))).toBe('invalid_request');
    expect(() => target.service.import(JSON.stringify({ ...bundle, version: 2 }))).toThrow(
      /version 2/,
    );
    const broken = structuredClone(bundle);
    broken.agents[0]!.connectionRef = 'missing';
    expect(code(JSON.stringify(broken))).toBe('invalid_request');
    expect(target.connections.list()).toEqual([]);
    expect(target.agents.list()).toEqual([]);
  });
});
