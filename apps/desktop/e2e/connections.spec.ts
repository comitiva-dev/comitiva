import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * End to end: the real app (renderer → main → runner → HTTP) against one fake
 * server that speaks all four API providers. Creates, tests, lists models,
 * edits, toggles and deletes connections through the UI, and checks that no
 * key ever lands in SQLite or in plain text on disk.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let app: ElectronApplication;
let page: Page;
let userData: string;

const KEYS = {
  anthropic: 'sk-e2e-anthropic-SECRET',
  openai: 'sk-e2e-openai-SECRET',
  google: 'AIza-e2e-google-SECRET',
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-'));
  app = await electron.launch({
    args: [
      appDir,
      // Ubuntu 24.04+ blocks the Chromium sandbox for unpackaged Electron (see CONTRIBUTING).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      // Deterministic, keyring-free secret storage for tests.
      '--password-store=basic',
    ],
    env: { ...process.env, COMITIVA_USER_DATA: userData, COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1' },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const form = () => page.getByTestId('connection-form');
const row = (name: string) => page.locator(`[data-testid="connection-row"][data-name="${name}"]`);

test('boots into the app shell with a ready runner', async () => {
  await expect(page.getByTestId('version')).toHaveText('v0.1.0');
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('connections-screen')).toBeVisible();
  await expect(page.getByTestId('empty')).toBeVisible();
  await expect(page.getByTestId('secret-banner')).toHaveCount(0);

  await page.getByTestId('nav-tools').click();
  await expect(page.getByTestId('placeholder-tools')).toBeVisible();
  await page.getByTestId('nav-agents').click();
  // No connection yet: the Agents screen points to Connections.
  await expect(page.getByTestId('agents-need-connection')).toBeVisible();
  await page.getByTestId('nav-connections').click();
});

interface Case {
  name: string;
  provider: 'anthropic' | 'openai-compatible' | 'google' | 'ollama';
  preset?: string;
  key?: string;
  baseUrl: () => string;
  advanced: boolean;
  firstModel: string;
}

const cases: Case[] = [
  {
    name: 'Claude',
    provider: 'anthropic',
    key: KEYS.anthropic,
    baseUrl: () => fake.urls.anthropic,
    advanced: true,
    firstModel: 'claude-haiku-4-5',
  },
  {
    name: 'My gateway',
    provider: 'openai-compatible',
    preset: 'custom',
    key: KEYS.openai,
    baseUrl: () => fake.urls.openai,
    advanced: false,
    firstModel: 'gpt-fake-mini',
  },
  {
    name: 'Gemini',
    provider: 'google',
    key: KEYS.google,
    baseUrl: () => fake.urls.google,
    advanced: true,
    firstModel: 'gemini-fake-flash',
  },
  {
    name: 'Local Ollama',
    provider: 'ollama',
    baseUrl: () => fake.urls.ollama,
    advanced: false,
    firstModel: 'llama-fake:latest',
  },
];

async function fill(input: Locator, value: string) {
  await input.fill('');
  await input.fill(value);
}

for (const c of cases) {
  test(`${c.provider}: create, fetch models, test in the form, save, test from the list`, async () => {
    await page.getByTestId('add-connection').click();
    await expect(form()).toBeVisible();
    await form().getByTestId('provider').selectOption(c.provider);
    if (c.preset) await form().getByTestId('preset').selectOption(c.preset);
    await fill(form().getByTestId('name'), c.name);
    if (c.key) await form().getByTestId('api-key').fill(c.key);
    if (c.advanced) await form().getByTestId('show-advanced').click();
    await fill(form().getByTestId('base-url'), c.baseUrl());

    await form().getByTestId('fetch-models').click();
    await expect(form().getByTestId('models-status')).toHaveAttribute('data-state', 'done');
    expect(await form().locator('[data-testid="model-options"] option').count()).toBeGreaterThan(0);
    // The first model is picked when none was set.
    await expect(form().getByTestId('default-model')).toHaveValue(c.firstModel);

    await form().getByTestId('form-test').click();
    await expect(form().getByTestId('form-test-result')).toHaveAttribute('data-ok', 'true');
    if (c.preset)
      await page.screenshot({ path: join(appDir, 'test-results', 'connection-form.png') });

    await form().getByTestId('save').click();
    await expect(form()).toHaveCount(0);
    await expect(row(c.name)).toBeVisible();
    await expect(row(c.name).getByTestId('provider-icon')).toHaveAttribute(
      'data-provider',
      c.provider,
    );
    await expect(row(c.name).getByTestId('last-test')).toHaveAttribute('data-ok', '');

    await row(c.name).getByTestId('test').click();
    await expect(row(c.name).getByTestId('last-test')).toHaveAttribute('data-ok', 'true');
    await expect(row(c.name).getByTestId('last-test')).toContainText(/ms/);
  });
}

test('a rejected key shows the auth error, by code, in the form', async () => {
  await row('Claude').getByTestId('edit').click();
  await form().getByTestId('api-key').fill('bad-key');
  await form().getByTestId('form-test').click();
  const result = form().getByTestId('form-test-result');
  await expect(result).toHaveAttribute('data-ok', 'false');
  await expect(result).toHaveText(/rejected|recusada/i);
  await form().getByTestId('cancel').click();
  await expect(form()).toHaveCount(0);
});

test('editing the name keeps the stored key', async () => {
  await row('Claude').getByTestId('edit').click();
  await expect(form().getByTestId('api-key')).toHaveValue('');
  await fill(form().getByTestId('name'), 'Claude (work)');
  await form().getByTestId('save').click();
  await expect(row('Claude (work)')).toBeVisible();
  await row('Claude (work)').getByTestId('test').click();
  await expect(row('Claude (work)').getByTestId('last-test')).toHaveAttribute('data-ok', 'true');
  // The runner received the key saved at creation, not a blank one.
  expect(fake.requests.filter((r) => r.provider === 'anthropic').at(-1)?.apiKey).toBe(
    KEYS.anthropic,
  );
});

test('the enabled toggle persists across a reload', async () => {
  const toggle = row('Gemini').getByTestId('toggle-enabled');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  // With connections saved, the app now opens on Agents.
  await expect(page.getByTestId('agents-screen')).toBeVisible();
  await page.getByTestId('nav-connections').click();
  await expect(row('Gemini').getByTestId('toggle-enabled')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // The last test survives the reload too.
  await expect(row('Local Ollama').getByTestId('last-test')).toHaveAttribute('data-ok', 'true');
});

test('delete asks for confirmation', async () => {
  await row('Local Ollama').getByTestId('delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(row('Local Ollama')).toBeVisible();

  await row('Local Ollama').getByTestId('delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row('Local Ollama')).toHaveCount(0);
  await expect(page.getByTestId('connection-row')).toHaveCount(3);
});

test('no key is stored in SQLite or in plain text on disk', async () => {
  const files = (await readdir(userData)).filter((f) => /^(comitiva\.db.*|secrets\.bin)$/.test(f));
  expect(files).toEqual(expect.arrayContaining(['comitiva.db', 'secrets.bin']));
  for (const file of files) {
    const bytes = await readFile(join(userData, file), 'latin1');
    for (const key of Object.values(KEYS)) expect(bytes, file).not.toContain(key);
  }
  await page.screenshot({ path: join(appDir, 'test-results', 'connections.png') });
});
