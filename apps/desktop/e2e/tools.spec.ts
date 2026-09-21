import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import {
  fakeHarnessBinaries,
  startFakeProviders,
  type FakeProviders,
} from '@comitiva/runner/testing';

/**
 * End to end for tools (Phase 5): renderer → main → runner → MCP → the real
 * filesystem server on a temp folder, and approvals back through the UI. The
 * exit criterion is the first test: an agent reads and creates a file in an
 * allowed folder, the write asks for approval, and a path outside is denied.
 * The fake providers script the model's tool calls with `[tool:NAME {json}]`.
 */

const appDir = join(__dirname, '..');
const bins = fakeHarnessBinaries(dirname(require.resolve('@comitiva/runner/package.json')));
let fake: FakeProviders;
let userData: string;
let work: string;
let outside: string;
let app: ElectronApplication;
let page: Page;
let claudeId: string;

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
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-tools-'));
  work = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-e2e-work-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-e2e-outside-')));
  await writeFile(join(work, 'notes.txt'), 'buy milk');
  await writeFile(join(outside, 'secret.txt'), 'top secret');

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
  // The native folder picker answers with the work folder.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, work);

  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-e2e',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  claudeId = claude.connection.id;
  await page.reload();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const chat = () => page.getByTestId('chat');
const lastReply = () => chat().locator('[data-testid="message"][data-role="assistant"]').last();
const toolCalls = () => lastReply().getByTestId('tool-call');
const shot = (name: string) =>
  page.screenshot({ path: join(appDir, 'test-results', `${name}.png`) });

async function open(agent: string) {
  await agentItem(agent).click();
  await expect(page.getByTestId('agent-title')).toHaveText(agent);
}

async function send(text: string) {
  const composer = page.getByTestId('composer');
  await composer.fill(text);
  await composer.press('Enter');
}

async function agentWithFolder(name: string, connectionId = claudeId) {
  await invoke('agents.create', {
    name,
    avatar: { color: 'teal' },
    connectionId,
    roots: [{ path: work, mode: 'readwrite' }],
    toolServerIds: ['filesystem'],
  });
  await page.reload();
  await open(name);
}

test('an agent reads and creates a file in its folder, asks before the write, and is refused outside', async () => {
  // The agent is set up through the form: folder picker, Files, permissions.
  await page.getByTestId('new-agent').click();
  const form = page.getByTestId('agent-form');
  await form.getByTestId('agent-name').fill('Filer');
  await form.getByTestId('agent-connection').selectOption({ label: 'Claude' });
  await form.getByTestId('add-root').click();
  await expect(form.getByTestId('agent-root')).toContainText(work);
  await expect(form.getByTestId('agent-root-mode')).toHaveValue('readwrite');
  await expect(form.locator('[data-testid="agent-tool"][data-id="filesystem"]')).toBeChecked();
  await expect(form.getByTestId('policy-ask')).toBeChecked();
  await form.getByTestId('save').click();
  await expect(agentItem('Filer')).toBeVisible();
  await open('Filer');
  await expect(page.getByTestId('panel-roots')).toContainText(work);
  await expect(page.getByTestId('panel-tools')).toContainText(/Files|Arquivos/);

  await send(
    [
      '[tool:fs__read_file {"path":"notes.txt"}]',
      '[tool:fs__write_file {"path":"summary.txt","content":"milk bought"}]',
      `[tool:fs__read_file {"path":"${join(outside, 'secret.txt')}"}]`,
    ].join(' '),
  );

  // The read ran on its own; the write waits for the user.
  await expect(toolCalls()).toHaveCount(2);
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'done');
  await expect(toolCalls().nth(1)).toHaveAttribute('data-state', 'awaiting');
  const card = chat().getByTestId('approval-card');
  await expect(card).toContainText('write_file');
  await expect(card).toContainText('summary.txt');
  await expect(agentItem('Filer').getByTestId('agent-awaiting')).toBeVisible();
  await expect(agentItem('Filer').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'awaiting-approval',
  );
  expect(existsSync(join(work, 'summary.txt'))).toBe(false);
  await shot('tools-approval');

  await card.getByTestId('approve-allow').click();
  await expect(card).toHaveCount(0);
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  expect(await readFile(join(work, 'summary.txt'), 'utf8')).toBe('milk bought');

  // Outside the folder: refused by the server, reported to the model.
  await expect(toolCalls()).toHaveCount(3);
  await expect(toolCalls().nth(1)).toHaveAttribute('data-state', 'done');
  await expect(toolCalls().nth(2)).toHaveAttribute('data-state', 'error');
  await toolCalls().nth(2).getByRole('button').click();
  await expect(toolCalls().nth(2).getByTestId('tool-output')).toContainText('outside_roots');
  await expect(lastReply().getByTestId('message-content')).toContainText('Result: outside_roots');
  await expect(agentItem('Filer').getByTestId('agent-awaiting')).toHaveCount(0);
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  await shot('tools-done');

  // Tool calls and results survive a reload.
  await page.reload();
  await open('Filer');
  await expect(toolCalls()).toHaveCount(3);
  await expect(toolCalls().nth(2)).toHaveAttribute('data-state', 'error');
});

test('a denied change is not made and the model is told', async () => {
  await agentWithFolder('Careful');
  await send('[tool:fs__delete {"path":"notes.txt"}]');
  const card = chat().getByTestId('approval-card');
  await card.getByTestId('approve-deny').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'denied');
  await expect(lastReply().getByTestId('message-content')).toContainText('Result: approval_denied');
  expect(existsSync(join(work, 'notes.txt'))).toBe(true);
});

test('allow always stops asking for that tool, for that agent', async () => {
  await agentWithFolder('Trusted');
  await send('[tool:fs__write_file {"path":"a.txt","content":"1"}]');
  await chat().getByTestId('approval-card').getByTestId('approve-always').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  await send('[tool:fs__write_file {"path":"b.txt","content":"2"}]');
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'done');
  await expect(chat().getByTestId('approval-card')).toHaveCount(0);
  expect(await readFile(join(work, 'b.txt'), 'utf8')).toBe('2');

  // Another agent still asks.
  await open('Careful');
  await send('[tool:fs__write_file {"path":"c.txt","content":"3"}]');
  await expect(chat().getByTestId('approval-card')).toBeVisible();
  await page.getByTestId('stop').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'cancelled');
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'none');
  expect(existsSync(join(work, 'c.txt'))).toBe(false);
});

test('a CLI harness reaches the same tools and approvals through the proxy', async () => {
  const cli = await invoke('connections.create', {
    provider: 'claude-code',
    name: 'Fake Claude Code',
    config: { binaryPath: bins.claude },
  });
  await agentWithFolder('Harnessed', cli.connection.id);
  await send('[mcp:fs__write_file {"path":"from-cli.txt","content":"hi from the harness"}]');
  const card = chat().getByTestId('approval-card');
  await expect(card).toContainText('from-cli.txt');
  await card.getByTestId('approve-allow').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  expect(await readFile(join(work, 'from-cli.txt'), 'utf8')).toBe('hi from the harness');
  await expect(toolCalls()).toHaveCount(1);
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'done');
});

test('the Tools screen lists the built-in server, tests it, and adds a server with a secret', async () => {
  await page.getByTestId('nav-tools').click();
  const files = page.locator('[data-testid="tool-server-row"][data-id="filesystem"]');
  await expect(files.getByTestId('builtin-badge')).toBeVisible();
  await expect(files.getByTestId('edit')).toHaveCount(0);
  await files.getByTestId('test').click();
  await expect(files.getByTestId('tool-name')).toHaveCount(7);

  // A third-party stdio server (the filesystem server itself, read-only), with a secret env var.
  const readOnlyDir = join(work, 'shared');
  await mkdir(readOnlyDir, { recursive: true });
  await page.getByTestId('add-tool-server').click();
  const form = page.getByTestId('tool-server-form');
  await form.getByTestId('tool-name-input').fill('Shared docs');
  await form.getByTestId('command').fill(process.execPath);
  await form
    .getByTestId('args')
    .fill(
      [
        require.resolve('@comitiva/mcp-servers/filesystem-bin'),
        '--root',
        `${readOnlyDir}:read`,
      ].join('\n'),
    );
  await form.getByTestId('add-row').click();
  await form.getByTestId('row-key').fill('DOCS_TOKEN');
  await form.getByTestId('row-secret').check();
  await form.getByTestId('row-value').fill('tok-e2e-secret-123');
  await form.getByTestId('save').click();
  const shared = page.locator('[data-testid="tool-server-row"][data-name="Shared docs"]');
  await expect(shared).toBeVisible();
  await shared.getByTestId('test').click();
  await expect(shared.getByTestId('tool-name')).toHaveCount(3);
  await shot('tools-screen');

  // Editing shows the secret as stored, never its value, and keeps it.
  await shared.getByTestId('edit').click();
  await expect(form.getByTestId('row-value')).toHaveValue('');
  await expect(form.getByTestId('row-value')).toHaveAttribute('type', 'password');
  await form.getByTestId('save').click();
  await expect(form).toHaveCount(0);

  // The secret is in neither the database nor the renderer's list.
  const listed = JSON.stringify(await invoke('toolServers.list'));
  expect(listed).not.toContain('tok-e2e-secret-123');
  for (const file of readdirSync(userData).filter((f) => f.startsWith('comitiva.db'))) {
    expect(readFileSync(join(userData, file)).includes('tok-e2e-secret-123')).toBe(false);
  }

  // Disabling a server takes it off the agent form's checklist.
  await shared.getByTestId('toggle-enabled').click();
  await expect(shared.getByTestId('toggle-enabled')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('new-agent').click();
  await expect(page.getByTestId('agent-form').getByTestId('agent-tool')).toHaveCount(1);
  await page.getByTestId('agent-form').getByTestId('cancel').click();
});
