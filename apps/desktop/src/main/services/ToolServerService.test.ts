import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  AppError,
  FILESYSTEM_TOOL_SERVER_ID,
  GOOGLE_DRIVE_TOOL_SERVER_ID,
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
let driveToken: () => Promise<string>;
const googleDrive = {
  command: '/app/electron',
  args: ['/app/google-drive.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  accessToken: () => driveToken(),
};
const draft = (d: ToolServerDraft) => ipcInvoke['toolServers.create'].input.parse(d);
const patch = (p: ToolServerPatch) =>
  ipcInvoke['toolServers.update'].input.parse({ id: 'x', patch: p }).patch;

beforeEach(() => {
  db = Database.open(':memory:');
  db.migrate(migrations);
  secrets = new MemorySecrets();
  driveToken = () => Promise.resolve('ya29.fresh');
  runner = {
    startToolServer: vi.fn<RunnerClient['startToolServer']>().mockResolvedValue([]),
    stopToolServer: vi.fn<RunnerClient['stopToolServer']>().mockResolvedValue(undefined),
  };
  service = new ToolServerService({
    repo: new ToolServerRepository(db),
    secrets,
    runner,
    filesystem,
    googleDrive,
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
    expect(service.list().map((t) => t.id)).toEqual([
      FILESYSTEM_TOOL_SERVER_ID,
      GOOGLE_DRIVE_TOOL_SERVER_ID,
    ]);
  });

  it('writes nothing when the keyring is unavailable', async () => {
    secrets.available = false;
    await expect(service.create(draft(search))).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(service.list()).toHaveLength(2);
  });

  it('tests a server through the runner; the filesystem server gets a scratch root', async () => {
    await service.test({ id: FILESYSTEM_TOOL_SERVER_ID });
    expect(runner.startToolServer).toHaveBeenCalledWith({
      toolServer: expect.objectContaining({ builtin: 'filesystem' }),
      roots: [{ path: expect.any(String), mode: 'readwrite' }],
    });
  });

  it('launches Google Drive with the bundled server, the gate and a fresh token per launch', async () => {
    const tokens = ['ya29.one', 'ya29.two'];
    driveToken = () => Promise.resolve(tokens.shift()!);
    const withDrive = agent({ toolServerIds: [GOOGLE_DRIVE_TOOL_SERVER_ID], roots: [] });
    const [first] = await service.launchesFor(withDrive);
    expect(first).toEqual({
      id: GOOGLE_DRIVE_TOOL_SERVER_ID,
      name: 'Google Drive',
      transport: 'stdio',
      builtin: 'google-drive',
      command: '/app/electron',
      args: ['/app/google-drive.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', GDRIVE_ACCESS_TOKEN: 'ya29.one' },
    });
    const [second] = await service.launchesFor(withDrive);
    expect(second).toMatchObject({ env: { GDRIVE_ACCESS_TOKEN: 'ya29.two' } });
    // Nothing about the account is stored with the server.
    expect(JSON.stringify(service.list())).not.toContain('ya29');
  });

  it('passes on why Drive cannot start, and skips it when disabled', async () => {
    driveToken = () => Promise.reject(new AppError('google_not_connected', 'no account'));
    const withDrive = agent({ toolServerIds: [GOOGLE_DRIVE_TOOL_SERVER_ID], roots: [] });
    await expect(service.launchesFor(withDrive)).rejects.toMatchObject({
      code: 'google_not_connected',
    });
    await expect(service.test({ id: GOOGLE_DRIVE_TOOL_SERVER_ID })).rejects.toMatchObject({
      code: 'google_not_connected',
    });
    await service.update(GOOGLE_DRIVE_TOOL_SERVER_ID, patch({ enabled: false }));
    expect(await service.launchesFor(withDrive)).toEqual([]);
  });

  it('tests unsaved settings under a throwaway id, then stops them', async () => {
    runner.startToolServer.mockResolvedValueOnce([
      { name: 'q', inputSchema: {}, annotations: { readOnlyHint: true } },
    ]);
    const tools = await service.test(
      ipcInvoke['toolServers.test'].input.parse({
        spec: { transport: 'stdio', command: 'npx', env: { KEY: { secret: 'sk-new' } } },
      }),
    );
    expect(tools).toHaveLength(1);
    const launch = runner.startToolServer.mock.calls[0]![0].toolServer;
    expect(launch).toMatchObject({
      id: expect.stringMatching(/^test-/),
      command: 'npx',
      env: { KEY: 'sk-new' },
    });
    expect(runner.stopToolServer).toHaveBeenCalledWith(launch.id);
    // Nothing was saved.
    expect(service.list()).toHaveLength(2);
    expect(secrets.values.size).toBe(0);
  });

  it('tests edited settings with the stored secrets kept, and stops even on failure', async () => {
    const saved = await service.create(draft(search));
    runner.startToolServer.mockRejectedValueOnce(new AppError('tool_server_failed', 'boom'));
    const target = ipcInvoke['toolServers.test'].input.parse({
      id: saved.id,
      spec: {
        transport: 'stdio',
        command: 'npx',
        args: ['search-mcp@2'],
        env: { API_KEY: { keepSecret: true }, REGION: { value: 'us' } },
      },
    });
    await expect(service.test(target)).rejects.toMatchObject({ code: 'tool_server_failed' });
    const launch = runner.startToolServer.mock.calls[0]![0].toolServer;
    expect(launch).toMatchObject({
      name: 'Search',
      args: ['search-mcp@2'],
      env: { API_KEY: 'sk-search-123', REGION: 'us' },
    });
    expect(runner.stopToolServer).toHaveBeenCalledWith(launch.id);
    // The saved server is unchanged.
    expect(service.list().find((t) => t.id === saved.id)!.args).toEqual(['-y', 'search-mcp']);

    const builtin = ipcInvoke['toolServers.test'].input.parse({
      id: FILESYSTEM_TOOL_SERVER_ID,
      spec: { transport: 'stdio', command: 'x' },
    });
    await expect(service.test(builtin)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
