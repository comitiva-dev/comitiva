import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * Export and import through the UI and the native dialogs (stubbed to a temp
 * folder): a conversation as Markdown, and agents with their connections and
 * tool servers as a bundle that another, empty Comitiva imports. No key or
 * secret is ever written to the bundle.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let downloads: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

async function launch(userData: string) {
  app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: { ...process.env, COMITIVA_USER_DATA: userData, COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1' },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
}

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

async function stubSave(name: string): Promise<string> {
  const path = join(downloads, name);
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);
  return path;
}

async function stubOpen(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
}

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  downloads = await mkdtemp(join(tmpdir(), 'comitiva-e2e-export-out-'));
  await launch(await mkdtemp(join(tmpdir(), 'comitiva-e2e-export-')));

  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-very-secret-key',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  // Disabled: an agent's enabled servers start with each run, and this one is not real.
  const gh = await invoke('toolServers.create', {
    name: 'GitHub',
    enabled: false,
    spec: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'github-mcp'],
      env: { GITHUB_TOKEN: { secret: 'ghp_super_secret' }, LOG: { value: 'info' } },
    },
  });
  await invoke('agents.create', {
    name: 'Planner',
    avatar: { color: 'violet', emoji: '🧭' },
    connectionId: claude.connection.id,
    role: 'You plan launches.',
    toolServerIds: [gh.id],
    tags: ['ops'],
  });
  await page.reload();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

test('exports a conversation as Markdown', async () => {
  await page.locator('[data-testid="agent-item"][data-name="Planner"]').click();
  const composer = page.getByTestId('composer');
  await composer.fill('Draft the launch checklist');
  await composer.press('Enter');
  await expect(
    page.locator('[data-testid="message"][data-role="assistant"]').last(),
  ).toHaveAttribute('data-status', 'complete');

  const path = await stubSave('launch.md');
  await page.getByTestId('export-conversation').click();
  await expect(page.getByTestId('transfer-saved')).toContainText('launch.md');
  const md = await readFile(path, 'utf8');
  expect(md).toMatch(/^# /);
  expect(md).toContain('- Agent: Planner');
  expect(md).toContain('- Model: Anthropic · claude-haiku-4-5');
  expect(md).toContain('Draft the launch checklist');
  expect(md).toContain('### Planner');
});

let bundlePath: string;

test('exports every agent as a bundle without keys or secrets', async () => {
  bundlePath = await stubSave('agents.json');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('export-all').click();
  await expect(page.getByTestId('transfer-saved')).toBeVisible();
  const text = await readFile(bundlePath, 'utf8');
  expect(text).not.toContain('sk-very-secret-key');
  expect(text).not.toContain('ghp_super_secret');
  expect(text).not.toContain('secretRef');
  const bundle = JSON.parse(text);
  expect(bundle).toMatchObject({ format: 'comitiva.bundle', version: 1 });
  expect(bundle.agents[0]).toMatchObject({ name: 'Planner', role: 'You plan launches.' });
});

test('imports the bundle into an empty Comitiva and says what is left to do', async () => {
  await app.close();
  await launch(await mkdtemp(join(tmpdir(), 'comitiva-e2e-import-')));
  await page.getByTestId('nav-settings').click();
  await stubOpen(bundlePath);
  await page.getByTestId('import-bundle').click();

  const report = page.getByTestId('import-report');
  await expect(report).toBeVisible();
  await expect(report.getByTestId('import-warning')).toHaveCount(2);
  await expect(report.locator('[data-code="key_needed"]')).toContainText('Claude');
  await expect(report.locator('[data-code="secret_needed"]')).toContainText('GITHUB_TOKEN');
  await page.screenshot({ path: join(appDir, 'test-results', 'export-import-report.png') });
  await page.getByTestId('import-report-close').click();

  // The agent is back, on a connection without a key.
  await expect(page.locator('[data-testid="agent-item"][data-name="Planner"]')).toBeVisible();
  const connections = await invoke('connections.list');
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ hasSecret: false, connection: { name: 'Claude' } });
  const [agent] = await invoke('agents.list');
  expect(agent).toMatchObject({
    role: 'You plan launches.',
    tags: ['ops'],
    avatar: { emoji: '🧭' },
  });
});
