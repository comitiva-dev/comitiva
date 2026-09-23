import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import {
  fakeHarnessBinaries,
  startFakeProviders,
  type FakeProviders,
} from '@comitiva/runner/testing';

/**
 * The packaged app starts its processes from its own resources, on every
 * platform: the runner (runner/bin.cjs), the MCP proxy for CLI harnesses
 * (runner/mcp-proxy.cjs), the built-in filesystem and Google Drive servers
 * (mcp-servers/*.cjs) and the migrations. Each test drives one of them
 * through the app, against the fake providers.
 */

const release = join(__dirname, '..', 'release');
const bins = fakeHarnessBinaries(dirname(require.resolve('@comitiva/runner/package.json')));

/** The packaged executable for this platform (electron-builder's unpacked output). */
function executable(): string {
  // electron-builder names the macOS folders mac-arm64 (arm64) and mac (x64).
  const macDirs = [`mac-${process.arch}`, 'mac', 'mac-universal'];
  const candidates =
    process.platform === 'darwin'
      ? macDirs.map((d) => join(release, d, 'Comitiva.app', 'Contents', 'MacOS', 'Comitiva'))
      : process.platform === 'win32'
        ? [join(release, 'win-unpacked', 'Comitiva.exe')]
        : [join(release, 'linux-unpacked', 'comitiva')];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`No packaged app under ${release}: run pnpm package first`);
  return found;
}

let fake: FakeProviders;
let work: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  input?: IpcInput<C>,
): Promise<IpcOutput<C>> {
  const result = await page.evaluate(
    ([c, i]) =>
      (
        globalThis as unknown as { api: { invoke(c: string, i: unknown): Promise<unknown> } }
      ).api.invoke(c, i),
    [channel, input] as const,
  );
  const r = result as { ok: true; value: IpcOutput<C> } | { ok: false; error: { code: string } };
  if (!r.ok) throw new Error(`${channel}: ${r.error.code}`);
  return r.value;
}

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 2, intervalMs: 1 });
  const userData = await mkdtemp(join(tmpdir(), 'comitiva-packaged-'));
  work = await mkdtemp(join(tmpdir(), 'comitiva-packaged-work-'));
  await writeFile(join(work, 'notes.txt'), 'packaged and working');
  app = await electron.launch({
    executablePath: executable(),
    // Linux CI and Ubuntu 24.04 restrict the unpacked binary's sandbox; installs do not.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--password-store=basic'],
    env: {
      ...process.env,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
      COMITIVA_DISABLE_UPDATES: '1',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 30_000,
  });
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const lastReply = () => page.locator('[data-testid="message"][data-role="assistant"]').last();

async function chatWith(agent: string, text: string) {
  await page.reload();
  await page.locator(`[data-testid="agent-item"][data-name="${agent}"]`).click();
  const composer = page.getByTestId('composer');
  await composer.fill(text);
  await composer.press('Enter');
}

test('is the packaged app, with the runner and the migrations from its resources', async () => {
  const info = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    resources: process.resourcesPath,
  }));
  expect(info.packaged).toBe(true);
  for (const file of [
    'runner/bin.cjs',
    'runner/mcp-proxy.cjs',
    'mcp-servers/filesystem.cjs',
    'mcp-servers/google-drive.cjs',
    'migrations/0007_message_search.sql',
  ]) {
    expect(existsSync(join(info.resources, file)), file).toBe(true);
  }
  // The runner answered its ping (status ready), and every migration ran: search needs 0007.
  await expect(invoke('search.query', { query: 'anything' })).resolves.toEqual({
    conversations: [],
    messages: [],
  });
  const updates = await invoke('updates.getStatus');
  expect(updates).toMatchObject({ state: 'disabled', disabledReason: 'env' });
});

test('an API agent reads a file through the bundled filesystem server', async () => {
  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-fake',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  await invoke('agents.create', {
    name: 'Reader',
    avatar: { color: 'indigo' },
    connectionId: claude.connection.id,
    roots: [{ path: work, mode: 'read' }],
    toolServerIds: ['filesystem'],
  });
  await chatWith('Reader', '[tool:fs__read_file {"path":"notes.txt"}]');
  await expect(lastReply()).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  const call = lastReply().getByTestId('tool-call');
  await expect(call).toHaveAttribute('data-state', 'done');
  await call.click();
  await expect(call.getByTestId('tool-output')).toContainText('packaged and working');
});

test('the bundled Google Drive server starts with the packaged binary', async () => {
  const resources = await app.evaluate(() => process.resourcesPath);
  const exe = await app.evaluate(() => process.execPath);
  const tools = await invoke('toolServers.test', {
    spec: {
      transport: 'stdio',
      command: exe,
      args: [join(resources, 'mcp-servers', 'google-drive.cjs')],
      env: {
        ELECTRON_RUN_AS_NODE: { value: '1' },
        GDRIVE_ACCESS_TOKEN: { value: 'ya29.fake' },
      },
    },
  });
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search', 'read']));
});

test('a CLI harness reaches the tools through the bundled MCP proxy', async () => {
  test.skip(process.platform === 'win32', 'the fake harness is a POSIX script');
  await mkdir(join(work, 'out'), { recursive: true });
  const cli = await invoke('connections.create', {
    provider: 'claude-code',
    name: 'Fake Claude Code',
    config: { binaryPath: bins.claude },
  });
  await invoke('agents.create', {
    name: 'Harnessed',
    avatar: { color: 'amber' },
    connectionId: cli.connection.id,
    roots: [{ path: work, mode: 'read' }],
    toolServerIds: ['filesystem'],
  });
  await chatWith('Harnessed', '[mcp:fs__read_file {"path":"notes.txt"}]');
  await expect(lastReply()).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
  await expect(lastReply().getByTestId('tool-call')).toHaveAttribute('data-state', 'done');
});
