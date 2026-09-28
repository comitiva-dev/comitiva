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
import { HUB_URL } from './global-setup';

/**
 * The Phase 8 exit criterion: two desktops see the same conversation live.
 * Two Comitiva apps, each with its own data and its own (fake) Ollama
 * connection, sign in to a real hub (the hub's image, in Docker), share a
 * workspace and an agent, and watch each other's replies stream in. Each
 * turn runs on the desktop that sent it.
 */

const appDir = join(__dirname, '..');
const suffix = Date.now().toString(36);
const anaEmail = `ana-${suffix}@example.com`;
const beaEmail = `bea-${suffix}@example.com`;
let fake: FakeProviders;

interface Desktop {
  app: ElectronApplication;
  page: Page;
  connectionId: string;
}
let ana: Desktop;
let bea: Desktop;

test.describe.configure({ mode: 'serial' });

async function launch(name: string): Promise<Desktop> {
  const userData = await mkdtemp(join(tmpdir(), `comitiva-e2e-hub-${name}-`));
  const app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: { ...process.env, COMITIVA_USER_DATA: userData, COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1' },
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  const connection = await invoke(page, 'connections.create', {
    provider: 'ollama',
    name: `${name}'s Ollama`,
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  return { app, page, connectionId: connection.connection.id };
}

/** Calls main through the preload bridge, as LocalBackend does (setup only). */
async function invoke<C extends IpcInvokeChannel>(
  page: Page,
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

async function signUp(page: Page, name: string, email: string) {
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('hub-url').fill(HUB_URL);
  await page.getByTestId('hub-connect').click();
  await expect(page.getByTestId('hub-meta')).toBeVisible();
  await page.getByTestId('hub-mode-register').click();
  await page.getByTestId('hub-name').fill(name);
  await page.getByTestId('hub-email').fill(email);
  await page.getByTestId('hub-password').fill('correct horse battery');
  await page.getByTestId('hub-submit').click();
  await expect(page.getByTestId('hub-user')).toContainText(email);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(appDir, 'test-results', `${name}.png`) });
const agentItem = (page: Page, name: string) =>
  page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const assistant = (page: Page) => page.locator('[data-testid="message"][data-role="assistant"]');

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  ana = await launch('ana');
  bea = await launch('bea');
});

test.afterAll(async () => {
  await ana?.app.close();
  await bea?.app.close();
  await fake?.close();
});

test('two desktops see the same conversation live', async () => {
  // Ana signs up, creates a workspace and invites Bea.
  await signUp(ana.page, 'Ana', anaEmail);
  await shot(ana.page, 'hub-settings');
  await ana.page.getByTestId('workspace-switcher').click();
  await ana.page.getByTestId('workspace-new').click();
  await ana.page.getByTestId('workspace-create-name').fill('Research');
  await ana.page.getByTestId('workspace-create-submit').click();
  await expect(ana.page.getByTestId('workspace-scope')).toHaveText('Workspace');
  await ana.page.getByTestId('nav-workspace').click();
  await ana.page.getByTestId('invite-email').fill(beaEmail);
  await ana.page.getByTestId('invite-submit').click();
  const link = await ana.page.getByTestId('invite-link').inputValue();
  expect(link).toContain('/invite/');
  await ana.page.emulateMedia({ colorScheme: 'dark' });
  await shot(ana.page, 'hub-workspace-dark');
  await ana.page.emulateMedia({ colorScheme: 'light' });

  // Bea signs up and joins with the link.
  await signUp(bea.page, 'Bea', beaEmail);
  await bea.page.getByTestId('workspace-switcher').click();
  await bea.page.getByTestId('workspace-join').click();
  await bea.page.getByTestId('workspace-join-link').fill(link);
  await bea.page.getByTestId('workspace-join-submit').click();
  await expect(bea.page.getByTestId('workspace-switcher')).toContainText('Research');
  await bea.page.getByTestId('workspace-switcher').click();
  await shot(bea.page, 'hub-switcher');
  await bea.page.getByTestId('workspace-switcher').click();

  // Each sees the other online.
  await expect(ana.page.getByTestId('presence')).toHaveAttribute('data-online', 'Bea', {
    timeout: 15_000,
  });
  await expect(bea.page.getByTestId('presence')).toHaveAttribute('data-online', 'Ana', {
    timeout: 15_000,
  });

  // Setup through the same IPC the UI uses: a shared agent, linked to each one's own connection.
  const workspaces = (await invoke(ana.page, 'hub.request', {
    method: 'GET',
    path: '/api/v1/workspaces',
  })) as Array<{ id: string }>;
  const workspaceId = workspaces[0]!.id;
  const agent = (await invoke(ana.page, 'hub.request', {
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/agents`,
    body: {
      name: 'Scout',
      avatar: { color: 'teal' },
      provider: 'ollama',
      model: 'llama-fake:latest',
    },
  })) as { id: string };
  for (const d of [ana, bea]) {
    await invoke(d.page, 'hubLinks.set', {
      agentId: agent.id,
      workspaceId,
      connectionId: d.connectionId,
      roots: [],
      toolServerIds: [],
    });
  }
  await expect(agentItem(ana.page, 'Scout')).toBeVisible();
  await expect(agentItem(bea.page, 'Scout')).toBeVisible();
  // The shared agent loads with each member's own link after a fresh load of the list.
  for (const d of [ana, bea]) {
    await d.page.reload();
    await expect(agentItem(d.page, 'Scout')).toBeVisible();
  }
  // A reloaded window is told again who is online.
  await expect(ana.page.getByTestId('presence')).toHaveAttribute('data-online', 'Bea', {
    timeout: 15_000,
  });

  // Ana asks; Bea opens the conversation and watches the reply stream in.
  await agentItem(ana.page, 'Scout').click();
  const composer = ana.page.getByTestId('composer');
  await composer.fill('Plan the offsite [chunks:40] [interval:100]');
  const sentAt = Date.now();
  await composer.press('Enter');
  await expect(assistant(ana.page).first()).toHaveAttribute('data-status', 'streaming');

  await agentItem(bea.page, 'Scout').click();
  await expect(bea.page.getByTestId('chat-title')).toHaveText(
    'Plan the offsite [chunks:40] [interval:100]',
    {
      timeout: 15_000,
    },
  );
  await expect(assistant(bea.page).first()).toHaveAttribute('data-status', 'streaming', {
    timeout: 15_000,
  });
  await expect(bea.page.getByTestId('chat-runner')).toContainText('Ana');
  // Bea sees Ana's message under Ana's name.
  await expect(
    bea.page.locator('[data-testid="message"][data-role="user"]').first(),
  ).toHaveAttribute('data-author', 'Ana');
  await expect(assistant(bea.page).first()).toContainText('chunk 5');
  const firstSeenAt = Date.now();
  await shot(bea.page, 'hub-bea-watching');
  await expect(assistant(bea.page).first()).toHaveAttribute('data-status', 'complete', {
    timeout: 30_000,
  });
  await expect(assistant(bea.page).first()).toContainText('chunk 39');
  await expect(assistant(ana.page).first()).toHaveAttribute('data-status', 'complete');
  expect(await assistant(bea.page).first().innerText()).toBe(
    await assistant(ana.page).first().innerText(),
  );
  test.info().annotations.push({
    type: 'latency',
    description: `sent → chunk 5 on the other desktop: ${firstSeenAt - sentAt} ms (chunks every 100 ms)`,
  });

  // Bea replies from her desktop, with her own connection; Ana sees it live.
  const requestsBefore = fake.requests.length;
  const beaComposer = bea.page.getByTestId('composer');
  await beaComposer.fill('And the budget? [chunks:20] [interval:100]');
  await beaComposer.press('Enter');
  await expect(assistant(ana.page)).toHaveCount(2, { timeout: 15_000 });
  await expect(assistant(ana.page).nth(1)).toHaveAttribute('data-status', 'streaming', {
    timeout: 15_000,
  });
  await expect(ana.page.getByTestId('chat-runner')).toContainText('Bea');
  await expect(
    ana.page.locator('[data-testid="message"][data-role="user"]').nth(1),
  ).toHaveAttribute('data-author', 'Bea');
  await expect(assistant(ana.page).nth(1)).toHaveAttribute('data-status', 'complete', {
    timeout: 30_000,
  });
  await expect(assistant(ana.page).nth(1)).toContainText('chunk 19');
  await shot(ana.page, 'hub-ana-after-bea');
  // Bea's turn went to the fake provider with the whole conversation as history.
  expect(fake.requests.length).toBeGreaterThan(requestsBefore);
});
