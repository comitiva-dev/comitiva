import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  FILESYSTEM_TOOL_SERVER_ID,
  ipcInvoke,
  type Agent,
  type ToolServerDraft,
  type ToolServerPatch,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import { Database } from '../db/Database';
import { ToolServerRepository } from '../db/repositories/ToolServerRepository';
import { MemorySecrets } from '../testing/MemorySecrets';
import { ToolServerService } from './ToolServerService';

const migrations = join(__dirname, '..', 'db', 'migrations');
let db: Database;
let secrets: MemorySecrets;
let runner: {
  startToolServer: Mock<RunnerClient['startToolServer']>;
  stopToolServer: Mock<RunnerClient['stopToolServer']>;
};
let service: ToolServerService;

const filesystem = {
  command: '/app/electron',
  args: ['/app/filesystem.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};
const draft = (d: ToolServerDraft) => ipcInvoke['toolServers.create'].input.parse(d);
const patch = (p: ToolServerPatch) =>
  ipcInvoke['toolServers.update'].input.parse({ id: 'x', patch: p }).patch;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  secrets = new MemorySecrets();
  runner = {
    startToolServer: vi.fn<RunnerClient['startToolServer']>().mockResolvedValue([]),
    stopToolServer: vi.fn<RunnerClient['stopToolServer']>().mockResolvedValue(undefined),
  };
  service = new ToolServerService({
    repo: new ToolServerRepository(db),
    secrets,
    runner,
    filesystem,
  });
});
afterEach(() => db.close());

const search: ToolServerDraft = {
  name: 'Search',
  spec: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'search-mcp'],
    env: { API_KEY: { secret: 'sk-search-123' }, REGION: { value: 'eu' } },
  },
};

const agent = (over: Partial<Agent> = {}) =>
  ({
    id: 'a',
    toolServerIds: [FILESYSTEM_TOOL_SERVER_ID],
    roots: [{ path: '/work', mode: 'readwrite' }],
    ...over,
  }) as Agent;

describe('ToolServerService', () => {
  it('keeps secret values in the SecretStore and only refs in SQLite', async () => {
    const created = await service.create(draft(search));
    expect(created.env).toEqual({
      API_KEY: { secretRef: `toolServer:${created.id}:env:API_KEY` },
      REGION: { value: 'eu' },
    });
    expect(secrets.values.get(`toolServer:${created.id}:env:API_KEY`)).toBe('sk-search-123');
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM tool_servers').all());
    expect(dump).not.toContain('sk-search-123');
  });

  it('resolves launches for an agent: secrets in, disabled servers and root-less filesystem out', async () => {
    const s = await service.create(draft(search));
    const launches = await service.launchesFor(
      agent({ toolServerIds: [FILESYSTEM_TOOL_SERVER_ID, s.id] }),
    );
    expect(launches).toEqual([
      { id: 'filesystem', name: 'Files', transport: 'stdio', builtin: 'filesystem', ...filesystem },
      {
        id: s.id,
        name: 'Search',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'search-mcp'],
        env: { API_KEY: 'sk-search-123', REGION: 'eu' },
      },
    ]);
    expect(await service.launchesFor(agent({ roots: [] }))).toEqual([]);
    await service.update(s.id, patch({ enabled: false }));
    expect(await service.launchesFor(agent({ toolServerIds: [s.id] }))).toEqual([]);
  });

  it('fails a launch with secret_missing when a stored secret is gone', async () => {
    const s = await service.create(draft(search));
    secrets.values.clear();
    await expect(service.launchesFor(agent({ toolServerIds: [s.id] }))).rejects.toMatchObject({
      code: 'secret_missing',
    });
  });

  it('keeps, replaces and removes secrets on update, and restarts the server in the runner', async () => {
    const s = await service.create(draft(search));
    const ref = `toolServer:${s.id}:env:API_KEY`;
    // keepSecret keeps the stored one; a new value can replace it.
    await service.update(
      s.id,
      patch({
        spec: { transport: 'stdio', command: 'npx', env: { API_KEY: { keepSecret: true } } },
      }),
    );
    expect(secrets.values.get(ref)).toBe('sk-search-123');
    await service.update(
      s.id,
      patch({
        spec: { transport: 'stdio', command: 'npx', env: { API_KEY: { secret: 'sk-new' } } },
      }),
    );
    expect(secrets.values.get(ref)).toBe('sk-new');
    // Switching to http drops the env secrets.
    const http = await service.update(
      s.id,
      patch({
        spec: {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: { secret: 'Bearer t' } },
        },
      }),
    );
    expect(secrets.values.has(ref)).toBe(false);
    expect(http).toMatchObject({ transport: 'http', command: null, env: {} });
    expect(runner.stopToolServer).toHaveBeenCalledWith(s.id);
    await expect(
      service.update(
        s.id,
        patch({
          spec: { transport: 'http', url: 'https://x.dev', headers: { X: { keepSecret: true } } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('lets built-ins only be enabled or disabled, and never deleted', async () => {
    await expect(
      service.update(FILESYSTEM_TOOL_SERVER_ID, patch({ name: 'x' })),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(
      (await service.update(FILESYSTEM_TOOL_SERVER_ID, patch({ enabled: false }))).enabled,
    ).toBe(false);
    await expect(service.delete(FILESYSTEM_TOOL_SERVER_ID)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('deletes a server with its secrets', async () => {
    const s = await service.create(draft(search));
    await service.delete(s.id);
    expect(secrets.values.size).toBe(0);
    expect(service.list().map((t) => t.id)).toEqual([FILESYSTEM_TOOL_SERVER_ID]);
  });

  it('writes nothing when the keyring is unavailable', async () => {
    secrets.available = false;
    await expect(service.create(draft(search))).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(service.list()).toHaveLength(1);
  });

  it('tests a server through the runner; the filesystem server gets a scratch root', async () => {
    await service.test(FILESYSTEM_TOOL_SERVER_ID);
    expect(runner.startToolServer).toHaveBeenCalledWith({
      toolServer: expect.objectContaining({ builtin: 'filesystem' }),
      roots: [{ path: expect.any(String), mode: 'readwrite' }],
    });
  });
});
