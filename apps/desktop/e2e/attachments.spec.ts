import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import {
  fakeHarnessBinaries,
  startFakeProviders,
  type FakeProviders,
} from '@comitiva/runner/testing';

/**
 * Attachments end to end (ADR 0012): files picked in the composer are stored
 * by main, shown as chips, sent as blocks, resolved to base64 before the run,
 * and translated per provider. A harness gets a note instead of the image.
 */

const appDir = join(__dirname, '..');
const bins = fakeHarnessBinaries(dirname(require.resolve('@comitiva/runner/package.json')));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const NOTES = '# Plan\nShip v0.1.0 on Friday.';

let fake: FakeProviders;
let userData: string;
let trace: string;
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
    env: {
      ...process.env,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
      FAKE_HARNESS_TRACE: trace,
    },
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

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-attach-'));
  trace = join(userData, 'harness-trace.jsonl');
  await launch();

  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Claude',
    apiKey: 'sk-fake',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-haiku-4-5' },
  });
  const openai = await invoke('connections.create', {
    provider: 'openai-compatible',
    name: 'OpenAI',
    apiKey: 'sk-fake',
    config: { preset: 'custom', baseUrl: fake.urls.openai, defaultModel: 'gpt-fake' },
  });
  await invoke('agents.create', {
    name: 'Reader',
    avatar: { color: 'indigo' },
    connectionId: claude.connection.id,
  });
  await invoke('agents.create', {
    name: 'Viewer',
    avatar: { color: 'emerald' },
    connectionId: openai.connection.id,
  });
  if (process.platform !== 'win32') {
    const harness = await invoke('connections.create', {
      provider: 'claude-code',
      name: 'Harness',
      config: { binaryPath: bins.claude },
    });
    await invoke('agents.create', {
      name: 'Coder',
      avatar: { color: 'amber' },
      connectionId: harness.connection.id,
    });
  }
  await page.reload();
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const chips = () => page.getByTestId('attachment-chip');
const lastUser = () => page.locator('[data-testid="message"][data-role="user"]').last();
const lastReply = () => page.locator('[data-testid="message"][data-role="assistant"]').last();

async function open(agent: string) {
  await agentItem(agent).click();
  await expect(page.getByTestId('agent-title')).toHaveText(agent);
}

async function attach(files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  await page.getByTestId('attach-input').setInputFiles(files);
}

/** The first request to a provider since `from` (the chat run; a title run comes after it). */
function requestSince(from: number, provider: string): Record<string, unknown> {
  const r = fake.requests.slice(from).find((q) => q.provider === provider);
  if (!r) throw new Error(`no ${provider} request`);
  return r.body as Record<string, unknown>;
}

test('an image and a text file reach Anthropic as an image and a document', async () => {
  await open('Reader');
  await attach([
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) },
  ]);
  await expect(chips()).toHaveCount(2);
  await expect(chips().nth(0)).toHaveAttribute('data-status', 'ready');
  await expect(chips().nth(1)).toHaveAttribute('data-status', 'ready');
  // Anthropic sees images: no hint.
  await expect(page.getByTestId('composer-images-hint')).toHaveCount(0);

  await page.getByTestId('composer').fill('Summarize these');
  const from = fake.requests.length;
  await page.getByTestId('send').click();
  await expect(chips()).toHaveCount(0);
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');

  const [first] = requestSince(from, 'anthropic').messages as Array<{ content: unknown[] }>;
  expect(first!.content).toEqual([
    { type: 'text', text: 'Summarize these' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    },
    {
      type: 'document',
      title: 'notes.md',
      source: { type: 'text', media_type: 'text/plain', data: NOTES },
    },
  ]);

  // The user's message shows the image (loaded from the attachment store) and the file.
  await expect(lastUser().getByTestId('message-document')).toContainText('notes.md');
  const image = lastUser().getByTestId('message-image');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(1);
  await page.screenshot({ path: join(appDir, 'test-results', 'attachments-sent.png') });
});

test('an image alone reaches an OpenAI-compatible endpoint as image_url', async () => {
  await open('Viewer');
  await attach([{ name: 'dot.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(chips().first()).toHaveAttribute('data-status', 'ready');
  const from = fake.requests.length;
  await page.getByTestId('send').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');
  const messages = requestSince(from, 'openai').messages as Array<{
    role: string;
    content: unknown;
  }>;
  expect(messages.find((m) => m.role === 'user')!.content).toEqual([
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
  ]);
});

test('files that are neither images nor text are refused on the chip', async () => {
  await open('Viewer');
  await attach([
    {
      name: 'archive.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK\u0003\u0004\u0000'),
    },
  ]);
  await expect(chips().first()).toHaveAttribute('data-status', 'failed');
  await expect(chips().first()).toHaveAttribute('data-error', 'unsupported_attachment');
  await expect(page.getByTestId('send')).toBeDisabled();
  await chips().first().getByTestId('attachment-remove').click();
  await expect(chips()).toHaveCount(0);
});

test('a CLI harness gets the text file and a note instead of the image', async () => {
  test.skip(process.platform === 'win32', 'the fake harness is a POSIX script');
  await open('Coder');
  await attach([
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) },
  ]);
  await expect(page.getByTestId('composer-images-hint')).toBeVisible();
  await page.getByTestId('composer').fill('Read the plan');
  await page.getByTestId('send').click();
  await expect(lastReply()).toHaveAttribute('data-status', 'complete');

  const lines = (await readFile(trace, 'utf8')).trim().split('\n');
  const stdin = lines
    .map((l) => JSON.parse(l) as { stdin?: string })
    .filter((l) => l.stdin !== undefined)
    .at(-1)!.stdin!;
  expect(stdin).toContain('Read the plan');
  expect(stdin).toContain('Ship v0.1.0 on Friday.');
  expect(stdin).toContain(
    '[Image "dot.png" attached but not sent: Claude Code does not accept images]',
  );
});

test('stored images still show after a restart', async () => {
  await app.close();
  await launch();
  await open('Reader');
  const image = lastUser().getByTestId('message-image');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(1);
});
