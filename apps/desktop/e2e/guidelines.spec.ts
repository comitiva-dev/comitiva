import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * End to end for guidelines (ADR 0020): import an AGENTS.md through the
 * (stubbed) open dialog, add and reorder one by hand, pick one in an agent's
 * form, and check the system prompt the provider receives: the role, then
 * each guideline that reaches the agent, in order. Export writes them back.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

const AGENTS_MD = `# Team guidelines

## House style
<!-- comitiva scope="all" -->

Write in plain English. Short sentences.

## Glossary

A comitiva is a group that travels together.

## Sources
<!-- comitiva scope="tags" tags="writing" -->

Cite every source with a link.
`;

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
  fake = await startFakeProviders({ chunks: 2, intervalMs: 1 });
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-guidelines-'));
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
  // The texts checked below are English, whatever the machine running the tests uses.
  await invoke('settings.update', { language: 'en' });
  const local = await invoke('connections.create', {
    provider: 'ollama',
    name: 'Local',
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  await invoke('agents.create', {
    name: 'Writer',
    avatar: { color: 'emerald' },
    connectionId: local.connection.id,
    role: 'You write.',
    tags: ['writing'],
  });
  await invoke('agents.create', {
    name: 'Helper',
    avatar: { color: 'indigo' },
    connectionId: local.connection.id,
    role: 'You help.',
  });
  await page.reload();
  await expect(page.getByTestId('agent-item')).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  await fake?.close();
});

const rows = () => page.getByTestId('guideline-row');
const row = (name: string) => page.locator(`[data-testid="guideline-row"][data-name="${name}"]`);
const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);

/** The system prompt of the last Ollama chat request whose user message starts with `text`. */
function systemPromptFor(text: string): string | undefined {
  const turn = fake.requests.findLast((r) => {
    const messages = r.body.messages as Array<{ role: string; content: string }> | undefined;
    return r.path === '/api/chat' && messages?.at(-1)?.content.startsWith(text);
  });
  const messages = turn?.body.messages as Array<{ role: string; content: string }> | undefined;
  return messages?.find((m) => m.role === 'system')?.content;
}

async function sendTo(agent: string, text: string) {
  await agentItem(agent).click();
  await expect(page.getByTestId('agent-title')).toHaveText(agent);
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
  await expect(
    page.locator('[data-testid="message"][data-role="assistant"]').last(),
  ).toHaveAttribute('data-status', 'complete');
}

test('an AGENTS.md comes in as one guideline per section, with its scopes', async () => {
  await page.getByTestId('nav-guidelines').click();
  await expect(page.getByTestId('guidelines-empty')).toBeVisible();

  const path = join(userData, 'AGENTS.md');
  await writeFile(path, AGENTS_MD);
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByTestId('import-guidelines').click();

  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'imported');
  await expect(rows()).toHaveCount(3);
  await expect(rows().first()).toHaveAttribute('data-name', 'House style');
  await expect(row('House style').getByTestId('guideline-reach')).toHaveText('reaches 2 agents');
  await expect(row('Sources').getByTestId('guideline-scope-badge')).toHaveText('Tags: writing');
  await expect(row('Sources').getByTestId('guideline-reach')).toHaveText('reaches 1 agent');
  await expect(row('Glossary').getByTestId('guideline-reach')).toHaveText('reaches 0 agents');
});

test('a guideline added by hand can be moved in the order', async () => {
  await page.getByTestId('add-guideline').click();
  const form = page.getByTestId('guideline-form');
  await form.getByTestId('save').click();
  await expect(form.getByText('Give the guideline a name.')).toBeVisible();
  await form.getByTestId('guideline-name').fill('Tone');
  await form.getByTestId('guideline-content').fill('Be warm and brief.');
  await form.getByTestId('scope-tags').check();
  await form.getByTestId('save').click();
  await expect(form.getByText('Add at least one tag.')).toBeVisible();
  await form.getByTestId('scope-agents').check();
  await form.getByTestId('save').click();
  await expect(form).toHaveCount(0);
  await expect(rows()).toHaveCount(4);

  await row('Tone').getByTestId('move-up').click();
  await expect(rows().nth(2)).toHaveAttribute('data-name', 'Tone');
  await page.reload();
  await page.getByTestId('nav-guidelines').click();
  await expect(rows().nth(2)).toHaveAttribute('data-name', 'Tone');
});

test('each agent’s run gets the role, then the guidelines that reach it, in order', async () => {
  await agentItem('Writer').click();
  await page.getByTestId('agent-edit').click();
  const box = (name: string) =>
    page
      .getByTestId('agent-guidelines')
      .locator('label', { hasText: name })
      .getByTestId('agent-guideline');
  await expect(box('House style')).toHaveAttribute('data-auto', 'all');
  await expect(box('House style')).toBeDisabled();
  await expect(box('Sources')).toHaveAttribute('data-auto', 'tag');
  await expect(box('Glossary')).not.toBeChecked();
  await box('Glossary').check();
  await page.getByTestId('save').click();
  await expect(page.getByTestId('agent-guidelines')).toHaveCount(0);

  await expect(page.getByTestId('panel-guidelines')).toHaveText('House style, Glossary, Sources');

  await sendTo('Writer', 'Draft the intro');
  expect(systemPromptFor('Draft the intro')).toBe(
    [
      'You write.',
      '# Guidelines',
      '## House style',
      'Write in plain English. Short sentences.',
      '## Glossary',
      'A comitiva is a group that travels together.',
      '## Sources',
      'Cite every source with a link.',
    ].join('\n\n'),
  );

  await sendTo('Helper', 'Say hi');
  expect(systemPromptFor('Say hi')).toBe(
    'You help.\n\n# Guidelines\n\n## House style\n\nWrite in plain English. Short sentences.',
  );
});

test('export writes every guideline as one AGENTS.md', async () => {
  const path = join(userData, 'exported-AGENTS.md');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);
  await page.getByTestId('nav-guidelines').click();
  await page.getByTestId('export-guidelines').click();
  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'exported');
  const text = await readFile(path, 'utf8');
  expect(text.match(/^## .+$/gm)).toEqual([
    '## House style',
    '## Glossary',
    '## Tone',
    '## Sources',
  ]);
  expect(text).toContain('<!-- comitiva scope="tags" tags="writing" -->');
});
