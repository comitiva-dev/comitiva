import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * End to end for chat: renderer → main → runner → fake providers → SQLite,
 * and back as live events. The Phase 4 exit criterion is the first test: two
 * agents respond at the same time. Setup (connections, agents) goes through
 * the same IPC the UI uses; everything under test goes through the UI.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

async function launch() {
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

/** Calls main through the preload bridge, as LocalBackend does. */
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
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-chat-'));
  await launch();

  const local = await invoke('connections.create', {
    provider: 'ollama',
    name: 'Local',
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'bad-key',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  for (const [name, color, connectionId] of [
    ['Alpha', 'indigo', local.connection.id],
    ['Beta', 'emerald', local.connection.id],
    ['Gamma', 'amber', claude.connection.id],
  ] as const) {
    await invoke('agents.create', { name, avatar: { color }, connectionId });
  }
  await page.reload();
  await expect(page.getByTestId('agent-item')).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const chat = () => page.getByTestId('chat');
const messages = (role?: 'user' | 'assistant') =>
  chat().locator(role ? `[data-testid="message"][data-role="${role}"]` : '[data-testid="message"]');
const conversationItems = () => page.getByTestId('conversation-item');
const shot = (name: string) =>
  page.screenshot({ path: join(appDir, 'test-results', `${name}.png`) });

/** Ollama's chat messages, without the system prompt. */
const chatMessages = (body: Record<string, unknown>) =>
  (body.messages as Array<{ role: string; content: string }>).filter((m) => m.role !== 'system');

async function open(agent: string) {
  await agentItem(agent).click();
  await expect(page.getByTestId('agent-title')).toHaveText(agent);
}

async function send(text: string) {
  const composer = page.getByTestId('composer');
  await composer.fill(text);
  await composer.press('Enter');
}

test('two agents respond at the same time', async () => {
  // ~3 s per reply: long enough to start the second while the first streams.
  await open('Alpha');
  await expect(page.getByTestId('new-conversation-pane')).toBeVisible();
  await send('Hello Alpha [chunks:40] [interval:75]');
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'streaming');

  await open('Beta');
  await send('Hello Beta [chunks:40] [interval:75]');
  await expect(messages('assistant').first()).toContainText('chunk 1');

  // Both stream at once: the sidebar shows both responding.
  await expect(agentItem('Alpha').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'running',
  );
  await expect(agentItem('Beta').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'running',
  );
  await shot('chat-parallel');

  // Beta is on screen; Alpha finishes in the background and counts as unread.
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'complete', {
    timeout: 15_000,
  });
  await expect(messages('assistant').first()).toContainText('chunk 39');
  await expect(agentItem('Alpha').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'idle',
    { timeout: 15_000 },
  );
  await expect(agentItem('Alpha').getByTestId('agent-unread')).toHaveText('1');
  await expect(agentItem('Beta').getByTestId('agent-unread')).toHaveCount(0);
});

test('opening a conversation marks it read; the title is generated after the first reply', async () => {
  await open('Alpha');
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'complete');
  await expect(agentItem('Alpha').getByTestId('agent-unread')).toHaveCount(0);
  // The placeholder (the first line) gives way to the title model's answer.
  await expect(conversationItems().first()).toHaveAttribute('data-title', /^chunk 0/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-title')).toHaveText(/^chunk 0/);
});

test('a second message continues the conversation with its history', async () => {
  await send('And again [chunks:2]');
  await expect(messages()).toHaveCount(4);
  await expect(messages('assistant').last()).toHaveAttribute('data-status', 'complete');
  const turn = fake.requests.find(
    (r) => r.path === '/api/chat' && chatMessages(r.body).at(-1)?.content.startsWith('And again'),
  )!;
  expect(chatMessages(turn.body).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
});

test('Stop cancels the reply and keeps what arrived', async () => {
  await page.getByTestId('new-conversation').click();
  await send('Long one [chunks:400] [interval:40]');
  await expect(messages('assistant').first()).toContainText('chunk 3');
  await expect(page.getByTestId('stop')).toBeVisible();
  await page.getByTestId('stop').click();
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('message-cancelled')).toBeVisible();
  await expect(messages('assistant').first()).toContainText('chunk 0');
  await expect(page.getByTestId('send')).toBeVisible();
  await expect(conversationItems()).toHaveCount(2);
});

test('a failed reply shows the error by code and retries in place', async () => {
  await open('Gamma');
  await send('Hi Gamma');
  const error = page.getByTestId('message-error');
  await expect(error).toHaveAttribute('data-code', 'auth_failed');
  await expect(agentItem('Gamma').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'error',
  );
  await shot('chat-error');

  // Fix the key, then retry: the same message streams again, no new row.
  const claude = (await invoke('connections.list')).find((c) => c.connection.name === 'Claude')!;
  await invoke('connections.update', { id: claude.connection.id, patch: { apiKey: 'sk-good' } });
  await page.getByTestId('retry').click();
  await expect(messages('assistant')).toHaveCount(1);
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'complete');
  await expect(error).toHaveCount(0);
  await expect(agentItem('Gamma').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'idle',
  );
});

test('rename and archive a conversation', async () => {
  await open('Alpha');
  const first = conversationItems().first();
  await first.hover();
  await first.getByTestId('conversation-rename').click();
  const input = page.getByTestId('conversation-rename-input');
  await input.fill('Parallel test');
  await input.press('Enter');
  await expect(conversationItems().filter({ hasText: 'Parallel test' })).toHaveCount(1);

  const renamed = conversationItems().filter({ hasText: 'Parallel test' });
  await renamed.hover();
  await renamed.getByTestId('conversation-archive').click();
  await expect(conversationItems()).toHaveCount(1);
  await page.getByTestId('toggle-archived').click();
  await expect(
    page.locator('[data-testid="conversation-item"][data-archived="true"]'),
  ).toHaveAttribute('data-title', 'Parallel test');
  await page.getByTestId('toggle-archived').click();
});

test('conversations and messages survive a restart', async () => {
  await app.close();
  await launch();
  await expect(page.getByTestId('agent-item')).toHaveCount(3);
  await open('Beta');
  await expect(messages('user').first()).toContainText('Hello Beta');
  await expect(messages('assistant').first()).toHaveAttribute('data-status', 'complete');
  await expect(messages('assistant').first()).toContainText('chunk 39');
  await expect(conversationItems().first()).toHaveAttribute('data-title', /^chunk 0/);
  await expect(page.getByTestId('agent-unread')).toHaveCount(0);
  // Virtuoso keeps rows hidden until it has measured them.
  await expect(messages('assistant').first()).toBeVisible();
  await shot('chat-restart');
});

test('deleting an agent removes its conversations from the sidebar', async () => {
  await open('Beta');
  await page.getByTestId('agent-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(agentItem('Beta')).toHaveCount(0);
  await expect(page.getByTestId('agent-item')).toHaveCount(2);
});
