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
 * Search from the quick switcher (Cmd/Ctrl+K): message text through SQLite
 * FTS5, accents folded, and a hit that opens its conversation, pages back to
 * the message and highlights it.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let app: ElectronApplication;
let page: Page;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

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

/** Sends through IPC and waits for the reply to finish. */
async function turn(conversationId: string, text: string) {
  await invoke('messages.send', { conversationId, content: [{ type: 'text', text }] });
  await expect
    .poll(async () => {
      const list = await invoke('conversations.list', { archived: false });
      return list.find((s) => s.conversation.id === conversationId)?.conversation.status;
    })
    .toBe('idle');
}

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 1, intervalMs: 1 });
  const userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-search-'));
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

  const local = await invoke('connections.create', {
    provider: 'ollama',
    name: 'Local',
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  const alpha = await invoke('agents.create', {
    name: 'Alpha',
    avatar: { color: 'indigo' },
    connectionId: local.connection.id,
  });
  const beta = await invoke('agents.create', {
    name: 'Beta',
    avatar: { color: 'emerald' },
    connectionId: local.connection.id,
  });
  // An old message, pushed off the first page (100 messages) by 55 more turns.
  const a = await invoke('conversations.create', { agentId: alpha.id });
  await turn(a.id, 'Plan the marmalade launch for the coastal stores');
  for (let i = 0; i < 55; i += 1) await turn(a.id, `filler turn ${i}`);
  const b = await invoke('conversations.create', { agentId: beta.id });
  await turn(b.id, 'O relatório final está pronto');
  await page.reload();
  await expect(page.getByTestId('agent-item')).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const switcher = () => page.getByTestId('quick-switcher');
const items = () => page.getByTestId('switcher-item');

test('finds an old message and opens it highlighted', async () => {
  await page.keyboard.press(`${mod}+K`);
  await expect(switcher()).toBeVisible();
  // With no query: agents and recent conversations.
  await expect(items().first()).toHaveAttribute('data-kind', 'agent');

  await page.getByTestId('switcher-input').fill('marmal');
  const hit = items()
    .filter({ has: page.getByTestId('switcher-snippet') })
    .first();
  await expect(hit).toHaveAttribute('data-kind', 'message');
  await expect(hit.locator('mark')).toHaveText('marmalade');
  await page.screenshot({ path: join(appDir, 'test-results', 'search-switcher.png') });
  await page.keyboard.press('Enter');

  await expect(switcher()).toHaveCount(0);
  await expect(page.getByTestId('agent-title')).toHaveText('Alpha');
  const target = page.locator('[data-testid="message"][data-highlighted]');
  await expect(target).toBeVisible();
  await expect(target).toContainText('marmalade launch');
  await expect(target).toBeInViewport();
});

test('folds accents and closes with Escape', async () => {
  await page.keyboard.press(`${mod}+K`);
  await page.getByTestId('switcher-input').fill('relatorio');
  await expect(items().filter({ has: page.getByTestId('switcher-snippet') })).toHaveCount(1);
  await expect(page.getByTestId('switcher-snippet').locator('mark')).toHaveText('relatório');
  await page.keyboard.press('Escape');
  await expect(switcher()).toHaveCount(0);
});

test('jumps to an agent by name and says when nothing matches', async () => {
  await page.keyboard.press(`${mod}+K`);
  await page.getByTestId('switcher-input').fill('zzzqqq');
  await expect(page.getByTestId('switcher-empty')).toBeVisible();
  await page.getByTestId('switcher-input').fill('bet');
  await expect(items().first()).toHaveAttribute('data-kind', 'agent');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('agent-title')).toHaveText('Beta');
});
