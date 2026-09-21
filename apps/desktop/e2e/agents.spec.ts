import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProviders, type FakeProviders } from '@comitiva/runner/testing';

/**
 * End to end for agents: renderer → main → SQLite, with models listed through
 * the runner against the fake providers. Covers the first-run sample offer,
 * the agent form, the sidebar, the inline role edit, duplicate and delete, and
 * the connection rules (in use, disabled). Names are matched by prefix so the
 * spec passes in English and Portuguese.
 */

const appDir = join(__dirname, '..');
let fake: FakeProviders;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 3, intervalMs: 1 });
  const userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-agents-'));
  app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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

const connectionForm = () => page.getByTestId('connection-form');
const agentForm = () => page.getByTestId('agent-form');
const connectionRow = (name: string) =>
  page.locator(`[data-testid="connection-row"][data-name="${name}"]`);
const agentItem = (prefix: string) =>
  page.locator(`[data-testid="agent-item"][data-name^="${prefix}"]`);
const shot = (name: string) =>
  page.screenshot({ path: join(appDir, 'test-results', `${name}.png`) });

async function fill(input: Locator, value: string) {
  await input.fill('');
  await input.fill(value);
}

test('with no connection, Agents points to Connections', async () => {
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('nav-agents').click();
  await expect(page.getByTestId('agents-need-connection')).toBeVisible();
  await expect(page.getByTestId('agents-empty')).toBeVisible();
  await page.getByTestId('sidebar-add-connection').click();
  await expect(page.getByTestId('connections-screen')).toBeVisible();
});

test('the first connection brings the sample-agent offer, which creates an agent', async () => {
  await page.getByTestId('add-connection').click();
  await connectionForm().getByTestId('provider').selectOption('ollama');
  await fill(connectionForm().getByTestId('name'), 'Local');
  await fill(connectionForm().getByTestId('base-url'), fake.urls.ollama);
  await connectionForm().getByTestId('fetch-models').click();
  await expect(connectionForm().getByTestId('default-model')).toHaveValue('llama-fake:latest');
  await connectionForm().getByTestId('save').click();
  await expect(connectionRow('Local')).toBeVisible();

  await page.getByTestId('nav-agents').click();
  await expect(page.getByTestId('sample-offer')).toBeVisible();
  await shot('agents-sample-offer');
  await page.getByTestId('sample-create').click();

  await expect(agentItem('Assist')).toBeVisible();
  await expect(agentItem('Assist').getByTestId('agent-avatar')).toHaveAttribute('data-emoji', '🤖');
  await expect(agentItem('Assist').getByTestId('agent-status')).toHaveAttribute(
    'data-status',
    'idle',
  );
  await expect(page.getByTestId('sample-offer')).toHaveCount(0);
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('role-view')).not.toBeEmpty();
});

test('an agent is created through the form with models fetched from its connection', async () => {
  // An Anthropic connection without a default model: the agent must pick one.
  await page.getByTestId('nav-connections').click();
  await page.getByTestId('add-connection').click();
  await connectionForm().getByTestId('provider').selectOption('anthropic');
  await fill(connectionForm().getByTestId('name'), 'Claude');
  await connectionForm().getByTestId('api-key').fill('sk-e2e-agents');
  await connectionForm().getByTestId('show-advanced').click();
  await fill(connectionForm().getByTestId('base-url'), fake.urls.anthropic);
  await connectionForm().getByTestId('save').click();
  await expect(connectionRow('Claude')).toBeVisible();

  await page.getByTestId('nav-agents').click();
  await page.getByTestId('new-agent').click();
  await expect(agentForm()).toBeVisible();
  await agentForm().getByTestId('agent-name').fill('Writer');
  await agentForm().getByTestId('agent-connection').selectOption({ label: 'Claude' });
  await expect(agentForm().getByTestId('agent-models-status')).toHaveAttribute(
    'data-state',
    'done',
  );
  expect(
    await agentForm().locator('[data-testid="agent-model-options"] option').count(),
  ).toBeGreaterThan(0);

  // No model and no connection default: saving is blocked in the form.
  await agentForm().getByTestId('save').click();
  await expect(agentForm().getByTestId('agent-model')).toHaveAttribute('aria-invalid', 'true');
  await agentForm().getByTestId('agent-model').fill('claude-haiku-4-5');

  // A template fills an empty role; replacing typed text asks first.
  await agentForm().getByTestId('template-writer').click();
  await expect(agentForm().getByTestId('agent-role')).not.toHaveValue('');
  await fill(agentForm().getByTestId('agent-role'), 'My own words.');
  await agentForm().getByTestId('template-reviewer').click();
  await expect(agentForm().getByTestId('template-confirm')).toBeVisible();
  await agentForm().getByTestId('template-replace').click();
  await expect(agentForm().getByTestId('agent-role')).not.toHaveValue('My own words.');

  await agentForm().getByTestId('avatar-color-emerald').click();
  await agentForm().locator('[data-testid="avatar-emoji"][data-emoji="✍️"]').click();
  await agentForm().getByTestId('agent-temperature').fill('0.3');
  await agentForm().getByTestId('agent-max-tokens').fill('1024');
  await agentForm().getByTestId('agent-tags-input').fill('docs, drafts');
  await agentForm().getByTestId('agent-tags-input').press('Enter');
  await expect(agentForm().getByTestId('agent-tag')).toHaveCount(2);
  await shot('agent-form');
  await agentForm().getByTestId('save').click();

  await expect(agentForm()).toHaveCount(0);
  const item = agentItem('Writer');
  await expect(item).toBeVisible();
  await expect(item.getByTestId('agent-avatar')).toHaveAttribute('data-emoji', '✍️');
  await expect(item.getByTestId('agent-avatar')).toHaveAttribute('data-color', 'emerald');
  await expect(page.getByTestId('panel-model')).toHaveText('claude-haiku-4-5');
  await expect(page.getByTestId('panel-temperature')).toHaveText('0.3');
  await expect(page.getByTestId('panel-max-tokens')).toHaveText('1024');
  await expect(page.getByTestId('panel-tag')).toHaveText(['docs', 'drafts']);
});

test('the role is edited in place and persists across a reload', async () => {
  await page.getByTestId('role-view').click();
  await fill(page.getByTestId('role-input'), 'You write release notes.');
  await page.getByTestId('role-input').press('Control+Enter');
  await expect(page.getByTestId('role-view')).toHaveText('You write release notes.');
  await shot('agents-panel');

  await page.reload();
  await expect(page.getByTestId('agents-screen')).toBeVisible();
  await agentItem('Writer').click();
  await expect(page.getByTestId('role-view')).toHaveText('You write release notes.');

  // Esc cancels an edit.
  await page.getByTestId('role-edit').click();
  await fill(page.getByTestId('role-input'), 'discarded');
  await page.getByTestId('role-input').press('Escape');
  await expect(page.getByTestId('role-view')).toHaveText('You write release notes.');
});

test('duplicate copies the agent; delete asks first', async () => {
  await page.getByTestId('agent-duplicate').click();
  const copy = agentItem('Writer (');
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('role-view')).toHaveText('You write release notes.');
  await expect(page.getByTestId('agent-item')).toHaveCount(3);

  await page.getByTestId('agent-delete').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(copy).toHaveCount(0);
  await expect(page.getByTestId('agent-item')).toHaveCount(2);
  await expect(page.getByTestId('agent-panel')).toHaveCount(0);
});

test('a connection in use cannot be deleted; the dialog lists its agents', async () => {
  await page.getByTestId('nav-connections').click();
  await connectionRow('Local').getByTestId('delete').click();
  await expect(page.getByTestId('delete-blocked')).toBeVisible();
  await expect(page.getByTestId('delete-blocked-agent')).toHaveText([/^Assist/]);
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.getByTestId('confirm-cancel').click();
  await expect(connectionRow('Local')).toBeVisible();
});

test('an agent on a disabled connection shows a warning and can still be edited', async () => {
  await connectionRow('Claude').getByTestId('toggle-enabled').click();
  await expect(connectionRow('Claude').getByTestId('toggle-enabled')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByTestId('nav-agents').click();
  await expect(agentItem('Writer').getByTestId('agent-connection-warning')).toHaveAttribute(
    'data-state',
    'disabled',
  );
  await agentItem('Writer').click();
  await expect(page.getByTestId('panel-connection-warning')).toBeVisible();

  await page.getByTestId('role-view').click();
  await fill(page.getByTestId('role-input'), 'Still editable.');
  await page.getByTestId('role-save').click();
  await expect(page.getByTestId('role-view')).toHaveText('Still editable.');

  // Moving it to another connection needs an enabled one; the form offers Local.
  await page.getByTestId('agent-edit').click();
  await agentForm().getByTestId('agent-connection').selectOption({ label: 'Local' });
  await agentForm().getByTestId('agent-model').fill('');
  await agentForm().getByTestId('save').click();
  await expect(agentForm()).toHaveCount(0);
  await expect(agentItem('Writer').getByTestId('agent-connection-warning')).toHaveCount(0);
  await shot('agents');
});
