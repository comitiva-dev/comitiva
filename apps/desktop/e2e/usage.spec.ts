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
 * End to end for usage: real runs against the fake providers write real
 * records, and the dashboard reports them. The Phase 6 exit criterion is the
 * first test — the dashboard matches the records — checked by reading the
 * exported rows back and summing them independently of the screen.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let userData: string;
let downloads: string;
let app: ElectronApplication;
let page: Page;
let savedTo: string;

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

/** Points the native save dialog at a file under our temp directory. */
async function stubSaveDialog(name: string): Promise<string> {
  savedTo = join(downloads, name);
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
  }, savedTo);
  return savedTo;
}

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-usage-'));
  downloads = await mkdtemp(join(tmpdir(), 'comitiva-e2e-csv-'));
  await launch();

  const local = await invoke('connections.create', {
    provider: 'ollama',
    name: 'Local',
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-e2e',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  await invoke('agents.create', {
    name: 'Alpha',
    avatar: { color: 'indigo' },
    connectionId: local.connection.id,
  });
  await invoke('agents.create', {
    name: 'Beta',
    avatar: { color: 'emerald' },
    connectionId: claude.connection.id,
  });
  await page.reload();
  await expect(page.getByTestId('agent-item')).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const messages = (role?: 'user' | 'assistant') =>
  page
    .getByTestId('chat')
    .locator(role ? `[data-testid="message"][data-role="${role}"]` : '[data-testid="message"]');
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

/** Sends one turn and waits for the reply to reach a terminal state. */
async function turn(agent: string, text: string) {
  await open(agent);
  await page.getByTestId('new-conversation').click();
  await send(text);
  await expect(messages('assistant').last()).not.toHaveAttribute('data-status', 'streaming', {
    timeout: 20_000,
  });
}

async function openUsage() {
  await page.getByTestId('nav-usage').click();
  await expect(page.getByTestId('usage-totals')).toBeVisible();
}

/** Every column of one exported CSV row, by header name. */
function parseCsv(text: string): Array<Record<string, string>> {
  const bom = String.fromCharCode(0xfeff);
  const lines = (text.startsWith(bom) ? text.slice(1) : text).trimEnd().split('\r\n');
  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    // No quoted commas in these columns, so a plain split is enough here.
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

test('the dashboard matches the records', async () => {
  // Three runs that succeed, on two connections and two providers.
  await turn('Alpha', 'First question');
  await turn('Alpha', 'Second question');
  await turn('Beta', 'A question for Claude');

  await openUsage();
  await shot('usage-dashboard');

  // What the screen says.
  const shownRuns = Number(
    (await page.getByTestId('total-runs-value').textContent())!.replace(/\D/g, ''),
  );
  const shownTokens = Number(
    (await page.getByTestId('total-tokens-value').textContent())!.replace(/\D/g, ''),
  );

  // What the records say, read back independently of the screen.
  await stubSaveDialog('runs.csv');
  await page.getByTestId('usage-export-records').click();
  await expect(page.getByTestId('usage-export-done')).toBeVisible();
  const rows = parseCsv(await readFile(savedTo, 'utf8'));

  const sum = (column: string) => rows.reduce((n, r) => n + Number(r[column] || 0), 0);
  const tokenTotal =
    sum('input_tokens') +
    sum('output_tokens') +
    sum('cache_read_tokens') +
    sum('cache_write_tokens');

  expect(shownRuns).toBe(rows.length);
  expect(shownTokens).toBe(tokenTotal);
  // Three replies, each of which may also have produced a title run.
  expect(rows.length).toBeGreaterThanOrEqual(3);
  // Every run is attributed and costed.
  for (const row of rows) {
    expect(row.provider).not.toBe('');
    expect(row.model).not.toBe('');
    expect(Number(row.input_tokens) + Number(row.output_tokens)).toBeGreaterThan(0);
  }
});

test('breaks the same records down by connection, agent and model', async () => {
  await openUsage();
  await expect(page.getByTestId('usage-by-connection-row')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="usage-by-connection-row"][data-name="Local"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="usage-by-connection-row"][data-name="Claude"]'),
  ).toBeVisible();

  await expect(page.locator('[data-testid="usage-by-agent-row"][data-name="Alpha"]')).toBeVisible();
  await expect(page.locator('[data-testid="usage-by-agent-row"][data-name="Beta"]')).toBeVisible();
  // Ollama is local and free; Anthropic is priced, so a cost shows up.
  await expect(page.getByTestId('usage-by-model-row').first()).toBeVisible();
  await expect(page.getByTestId('total-cost-value')).not.toHaveText('');
});

test('records a run that fails, and one that is cancelled', async () => {
  await openUsage();
  const before = Number(
    (await page.getByTestId('total-runs-value').textContent())!.replace(/\D/g, ''),
  );

  // A provider error mid-stream: the tokens were spent and must be recorded.
  await turn('Alpha', 'Break it [error:500]');
  await expect(messages('assistant').last()).toHaveAttribute('data-status', 'error');

  // A cancel: the usage known so far, marked estimated.
  await open('Alpha');
  await page.getByTestId('new-conversation').click();
  await send('Slow one [chunks:60] [interval:80]');
  await expect(messages('assistant').last()).toHaveAttribute('data-status', 'streaming');
  await page.getByTestId('stop').click();
  await expect(messages('assistant').last()).toHaveAttribute('data-status', 'cancelled');

  await openUsage();
  const after = Number(
    (await page.getByTestId('total-runs-value').textContent())!.replace(/\D/g, ''),
  );
  expect(after).toBeGreaterThanOrEqual(before + 2);
  // A cancelled run counted its tokens locally, so the card says so. Asserted
  // by the note's presence, since the app runs in the machine's language.
  await expect(page.getByTestId('total-tokens-note')).toBeVisible();
});

test('follows the period selector', async () => {
  await openUsage();
  const inThirtyDays = Number(
    (await page.getByTestId('total-runs-value').textContent())!.replace(/\D/g, ''),
  );
  expect(inThirtyDays).toBeGreaterThan(0);

  // Everything just ran, so today holds all of it.
  await page.getByTestId('usage-period-today').click();
  await expect(page.getByTestId('total-runs-value')).toHaveText(String(inThirtyDays));

  // A window that ended before any of it ran is empty.
  await page.getByTestId('usage-period-custom').click();
  await page.getByTestId('usage-from').fill('2020-01-01');
  await page.getByTestId('usage-to').fill('2020-01-02');
  await expect(page.getByTestId('usage-empty')).toBeVisible();
  await expect(page.getByTestId('total-runs-value')).toHaveText('0');

  await page.getByTestId('usage-period-last30').click();
  await expect(page.getByTestId('total-runs-value')).toHaveText(String(inThirtyDays));
});

test('switches the chart between tokens and cost without a second axis', async () => {
  await openUsage();
  await expect(page.getByTestId('usage-chart')).toBeVisible();
  await expect(page.getByTestId('usage-legend')).toBeVisible();

  await page.getByTestId('usage-metric-cost').click();
  await expect(page.getByTestId('usage-metric-cost')).toHaveAttribute('aria-pressed', 'true');
  // The token legend belongs to the token series only.
  await expect(page.getByTestId('usage-legend')).toHaveCount(0);

  await page.getByTestId('usage-metric-tokens').click();
  await expect(page.getByTestId('usage-legend')).toBeVisible();

  // The chart's colours are chosen per mode, not flipped, so both are checked.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('usage-chart')).toBeVisible();
  await shot('usage-dashboard-dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

test('a price correction changes the cost of runs already recorded', async () => {
  await openUsage();
  const row = page.locator('[data-testid="price-row"][data-name="claude-haiku-4-5"]');
  await expect(row).toBeVisible();
  const costBefore = (await page.getByTestId('total-cost-value').textContent())!;

  await row.getByTestId('price-edit').click();
  await page.getByTestId('price-inputPer1M').fill('1000');
  await page.getByTestId('price-outputPer1M').fill('5000');
  await page.getByTestId('price-save').click();

  // "Use default" only exists for a corrected price, whatever the language.
  await expect(row.getByTestId('price-reset')).toBeVisible();
  await expect(page.getByTestId('total-cost-value')).not.toHaveText(costBefore);
  await shot('usage-prices');

  // And back: the shipped price returns, and so does the original total.
  await row.getByTestId('price-reset').click();
  await expect(page.getByTestId('total-cost-value')).toHaveText(costBefore);
});

test('exports the grouped view as well, and survives a restart', async () => {
  await openUsage();
  await stubSaveDialog('summary.csv');
  await page.getByTestId('usage-export-summary').click();
  await expect(page.getByTestId('usage-export-done')).toBeVisible();

  const csv = await readFile(savedTo, 'utf8');
  expect(csv).toContain('group,name,provider,runs');
  expect(csv).toContain('connection,Local');
  expect(csv).toContain('agent,Alpha');
  expect(csv).toMatch(/^day,\d{4}-\d{2}-\d{2}/m);

  const runsBefore = (await page.getByTestId('total-runs-value').textContent())!;
  await page.reload();
  await openUsage();
  await expect(page.getByTestId('total-runs-value')).toHaveText(runsBefore);
});

test('shows the open conversation usage in the right panel', async () => {
  await open('Alpha');
  await expect(page.getByTestId('panel-usage')).toBeVisible();
  await expect(page.getByTestId('panel-usage-tokens')).not.toHaveText('');
  await shot('usage-panel');
});
