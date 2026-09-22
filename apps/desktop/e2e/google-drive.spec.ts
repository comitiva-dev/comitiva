import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import { startFakeGoogle, type FakeGoogle } from '@comitiva/mcp-servers/testing';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * End to end for Google Drive (Phase 5b): the OAuth client is set up and the
 * account connected from the Tools screen (loopback + PKCE against a fake
 * Google, with `shell.openExternal` standing in for the browser), then an
 * agent reads a Google Doc and creates another one after approval, through
 * main → runner → the bundled Drive server → the fake Drive API. The exit
 * criterion is the first test.
 */

const appDir = join(__dirname, '..');
const CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-e2e-client-secret';
const DOC = 'application/vnd.google-apps.document';

let fake: FakeProviders;
let google: FakeGoogle;
let userData: string;
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
  google = await startFakeGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    email: 'test@example.com',
  });
  google.addFile({
    id: 'doc-brief',
    name: 'Launch brief',
    mimeType: DOC,
    content: '# Launch brief\n\nWe launch on Monday.',
  });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-drive-'));

  app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: {
      ...process.env,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
      COMITIVA_GOOGLE_OAUTH_BASE_URL: google.url,
      COMITIVA_GOOGLE_API_BASE_URL: google.url,
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  // The "browser": opens the consent page, which approves at once, and follows
  // its redirect back to Comitiva's loopback listener.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      const consent = await fetch(url, { redirect: 'manual' });
      const location = consent.headers.get('location');
      if (location) await fetch(location);
    };
  });

  await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-e2e',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  await page.reload();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
  await google?.close();
});

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const chat = () => page.getByTestId('chat');
const lastReply = () => chat().locator('[data-testid="message"][data-role="assistant"]').last();
const toolCalls = () => lastReply().getByTestId('tool-call');
const driveRow = () => page.locator('[data-testid="tool-server-row"][data-id="google-drive"]');
const account = () => driveRow().getByTestId('drive-account');
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

function storedFiles(): Buffer[] {
  return readdirSync(userData)
    .filter((f) => f.startsWith('comitiva.db'))
    .map((f) => readFileSync(join(userData, f)));
}

test('connects Google Drive, reads a Google Doc and creates another one after approval', async () => {
  // Set up the OAuth client and connect, from the Tools screen.
  await page.getByTestId('nav-tools').click();
  await expect(driveRow().getByTestId('builtin-badge')).toBeVisible();
  await expect(account()).toHaveAttribute('data-state', 'unconfigured');
  await account().getByTestId('drive-setup').click();
  const setup = page.getByTestId('google-drive-setup');
  await setup.getByTestId('save').click();
  await expect(setup.getByTestId('problem-clientId')).toBeVisible();
  await setup.getByTestId('drive-client-id').fill(CLIENT_ID);
  await setup.getByTestId('drive-client-secret').fill(CLIENT_SECRET);
  await shot('drive-setup');
  await setup.getByTestId('save').click();
  await expect(setup).toHaveCount(0);
  await expect(account()).toHaveAttribute('data-state', 'disconnected');
  await account().getByTestId('drive-connect').click();
  await expect(account()).toHaveAttribute('data-state', 'connected');
  await expect(account().getByTestId('drive-status')).toContainText('test@example.com');

  // Test lists the five tools with what each does to approvals.
  await driveRow().getByTestId('test').click();
  await expect(driveRow().getByTestId('tool-name')).toHaveCount(5);
  const badge = (tool: string) =>
    driveRow().locator(`[data-testid="tool-name"][data-tool="${tool}"] [data-testid="tool-badge"]`);
  await expect(badge('read')).toHaveAttribute('data-badge', 'readOnly');
  await expect(badge('create')).toHaveAttribute('data-badge', 'asks');
  await expect(badge('update').nth(1)).toHaveAttribute('data-badge', 'destructive');
  await shot('drive-connected');

  // An agent with Drive ticked in its form.
  await page.getByTestId('new-agent').click();
  const form = page.getByTestId('agent-form');
  await form.getByTestId('agent-name').fill('Drive helper');
  await form.getByTestId('agent-connection').selectOption({ label: 'Claude' });
  await form.locator('[data-testid="agent-tool"][data-id="google-drive"]').check();
  await expect(form.getByTestId('drive-not-connected')).toHaveCount(0);
  await form.getByTestId('save').click();
  await open('Drive helper');

  await send(
    [
      '[tool:gdrive__search {"query":"launch"}]',
      '[tool:gdrive__read {"fileId":"doc-brief"}]',
      '[tool:gdrive__create {"name":"Launch summary","kind":"doc","content":"# Summary\\n\\nMonday."}]',
    ].join(' '),
  );

  // Search and read run on their own; the create waits for the user.
  await expect(toolCalls()).toHaveCount(3);
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'done');
  await expect(toolCalls().nth(1)).toHaveAttribute('data-state', 'done');
  await expect(toolCalls().nth(2)).toHaveAttribute('data-state', 'awaiting');
  await toolCalls().nth(1).getByRole('button').first().click();
  await expect(toolCalls().nth(1).getByTestId('tool-output')).toContainText('We launch on Monday.');
  const card = chat().getByTestId('approval-card');
  await expect(card).toContainText('create');
  await expect(card.getByTestId('approval-targets')).toContainText('name: Launch summary');
  expect([...google.files.values()].some((f) => f.name === 'Launch summary')).toBe(false);
  await shot('drive-approval');

  await card.getByTestId('approve-allow').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  await expect(toolCalls().nth(2)).toHaveAttribute('data-state', 'done');
  const created = [...google.files.values()].find((f) => f.name === 'Launch summary');
  expect(created).toMatchObject({ mimeType: DOC, parents: ['root'] });
  expect(created!.content.toString()).toBe('# Summary\n\nMonday.');
  await expect(lastReply().getByTestId('message-content')).toContainText('Created');

  // Every Drive call carried an access token from the OAuth flow.
  const driveCalls = google.requests.filter((r) => r.path.includes('/drive/v3/'));
  expect(driveCalls.every((r) => /^Bearer ya29\.fake-/.test(r.authorization ?? ''))).toBe(true);

  // Neither the tokens nor the client secret are in the database or reach the renderer.
  const token = driveCalls.at(-1)!.authorization!.slice('Bearer '.length);
  const refresh = google.requests
    .filter((r) => r.path === '/token')
    .map((r) => new URLSearchParams(r.body).get('refresh_token'))
    .find(Boolean);
  const seen = JSON.stringify([
    await invoke('googleDrive.getStatus'),
    await invoke('toolServers.list'),
  ]);
  for (const secret of [token, CLIENT_SECRET, ...(refresh ? [refresh] : [])]) {
    expect(seen).not.toContain(secret);
    for (const file of storedFiles()) expect(file.includes(secret)).toBe(false);
  }
});

test('after disconnecting, an agent with Drive cannot send until it connects again', async () => {
  await page.getByTestId('nav-tools').click();
  await account().getByTestId('drive-disconnect').click();
  await page.getByTestId('confirm-ok').click();
  await expect(account()).toHaveAttribute('data-state', 'disconnected');
  expect(google.oauth.revoked).toHaveLength(1);

  await page.getByTestId('nav-agents').click();
  await open('Drive helper');
  await send('hello');
  await expect(page.getByTestId('composer-error')).toHaveAttribute(
    'data-code',
    'google_not_connected',
  );

  // Connect again: the next send works.
  await page.getByTestId('nav-tools').click();
  await account().getByTestId('drive-connect').click();
  await expect(account()).toHaveAttribute('data-state', 'connected');
  await page.getByTestId('nav-agents').click();
  await open('Drive helper');
  await send('[tool:gdrive__search {"type":"doc"}]');
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  await expect(toolCalls().nth(0)).toHaveAttribute('data-state', 'done');
});

test('a third-party server is tested from the form before saving and shows its annotations', async () => {
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('add-tool-server').click();
  const form = page.getByTestId('tool-server-form');
  await form.getByTestId('tool-name-input').fill('Docs folder');
  await form.getByTestId('command').fill(process.execPath);
  // The filesystem server run by hand: read-only (no --gated-by-client).
  await form
    .getByTestId('args')
    .fill([require.resolve('@comitiva/mcp-servers/filesystem-bin'), '--root', userData].join('\n'));
  await form.getByTestId('form-test').click();
  await expect(form.getByTestId('tool-name')).toHaveCount(3);
  await expect(
    form.locator('[data-testid="tool-name"][data-tool="read_file"] [data-testid="tool-badge"]'),
  ).toHaveAttribute('data-badge', 'readOnly');
  await shot('tools-form-test');
  await form.getByTestId('cancel').click();
  // Nothing was saved.
  await expect(
    page.locator('[data-testid="tool-server-row"][data-name="Docs folder"]'),
  ).toHaveCount(0);
});
