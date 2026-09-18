import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAnthropic, type FakeAnthropic } from '@comitiva/runner/testing';

/**
 * End-to-end spike: the real app (main + runner + renderer) against a fake
 * Anthropic SSE server. Two conversations stream at once; cancelling one does
 * not affect the other. Also records event → paint latency.
 */

const appDir = join(__dirname, '..');
let fake: FakeAnthropic;
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  fake = await startFakeAnthropic();
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-'));
  app = await electron.launch({
    args: [
      appDir,
      // Ubuntu 24.04+ blocks the Chromium sandbox for unpackaged Electron (see CONTRIBUTING).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      // Deterministic, keyring-free secret storage for tests.
      '--password-store=basic',
    ],
    env: {
      ...process.env,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ANTHROPIC_BASE_URL: fake.url,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
    },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const pane = (id: 'a' | 'b') => page.getByTestId(`pane-${id}`);

test('boots with IPC and a ready runner', async () => {
  await expect(page.getByTestId('version')).toHaveText('v0.1.0');
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe('0.1.0');
});

test('saves and tests the API key without exposing it to the renderer', async () => {
  await page.getByTestId('api-key').fill('sk-fake-key');
  await page.getByTestId('save-key').click();
  await expect(page.getByTestId('api-key')).toHaveValue('');
  await page.getByTestId('test-key').click();
  await expect(page.getByTestId('key-status')).toHaveText(/works|funciona/);

  const onDisk = await readFile(join(userData, 'secrets.bin'), 'utf8');
  expect(onDisk).not.toContain('sk-fake-key');
});

test('streams two conversations in parallel and cancels one independently', async () => {
  // A streams for ~10 s and B for ~2 s, so both are mid-stream long enough to
  // observe even on a loaded CI machine.
  await pane('a').getByTestId('input').fill('long [chunks:1000] [interval:10]');
  await pane('b').getByTestId('input').fill('short [chunks:200] [interval:10]');
  await pane('a').getByTestId('send').click();
  await pane('b').getByTestId('send').click();

  // Both stream at the same time: B is still streaming once A has output, and vice versa.
  await expect(pane('a').getByTestId('output')).toContainText('chunk 3');
  await expect(pane('b').getByTestId('output')).toContainText('chunk 3');
  await expect(pane('b').getByTestId('status')).toHaveAttribute('data-status', 'streaming');
  await expect(pane('a').getByTestId('status')).toHaveAttribute('data-status', 'streaming');

  await pane('a').getByTestId('cancel').click();
  await expect(pane('a').getByTestId('status')).toHaveAttribute('data-status', 'cancelled');
  await expect(pane('b').getByTestId('status')).toHaveAttribute('data-status', 'done', {
    timeout: 15_000,
  });

  await expect(pane('b').getByTestId('output')).toContainText('chunk 199');
  await expect(pane('a').getByTestId('output')).not.toContainText('chunk 999');
  await expect(pane('b').getByTestId('usage')).toContainText('400');
  await expect(pane('a').getByTestId('usage')).not.toHaveText(/—/);

  const latency = pane('b').getByTestId('latency');
  await expect(latency).toBeVisible();
  const stats = {
    n: Number(await latency.getAttribute('data-n')),
    p50: Number(await latency.getAttribute('data-p50')),
    p95: Number(await latency.getAttribute('data-p95')),
    max: Number(await latency.getAttribute('data-max')),
  };
  expect(stats.n).toBeGreaterThan(10);

  await mkdir(join(appDir, 'test-results'), { recursive: true });
  await writeFile(join(appDir, 'test-results', 'latency.json'), JSON.stringify(stats, null, 2));
  await page.screenshot({ path: join(appDir, 'test-results', 'spike.png') });
  console.log(
    `event → paint latency (fake provider, 10 ms/token, 200 tokens): ${JSON.stringify(stats)}`,
  );

  // Main also appended the samples to the latency log.
  await expect
    .poll(async () => readFile(join(userData, 'logs', 'latency.jsonl'), 'utf8').catch(() => ''))
    .toContain('spike-b');
});
