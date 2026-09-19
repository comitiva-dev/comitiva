import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fakeHarnessBinaries } from '@comitiva/runner/testing';

/**
 * End to end for CLI harness connections: renderer → main → runner → a fake
 * `claude` / `codex` binary (same line formats as the real ones). Detects the
 * binary on PATH, tests (version, login, sandbox, a real prompt), saves, and
 * shows actionable errors by code.
 */

const appDir = join(__dirname, '..');
const bins = fakeHarnessBinaries(dirname(require.resolve('@comitiva/runner/package.json')));
let app: ElectronApplication;
let page: Page;
let binDir: string;

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'win32', 'the fake harness is a POSIX script');

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-cli-'));
  // A PATH where `claude` and `codex` are the fakes, so detection never finds real CLIs.
  binDir = await mkdtemp(join(tmpdir(), 'comitiva-e2e-bin-'));
  await symlink(bins.claude, join(binDir, 'claude'));
  await symlink(bins.codex, join(binDir, 'codex'));
  // A Claude Code without a login.
  const loggedOut = join(binDir, 'claude-logged-out');
  await writeFile(loggedOut, `#!/bin/sh\nFAKE_HARNESS_LOGGED_OUT=1 exec "${bins.claude}" "$@"\n`);
  await chmod(loggedOut, 0o755);

  app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
});

test.afterAll(async () => {
  await app?.close();
});

const form = () => page.getByTestId('connection-form');
const row = (name: string) => page.locator(`[data-testid="connection-row"][data-name="${name}"]`);

test('creates a Claude Code connection: detect on PATH, test, save', async () => {
  await page.getByTestId('add-connection').first().click();
  await form().getByTestId('provider').selectOption('claude-code');

  // Text depends on the UI language; the notice itself must always be there.
  await expect(form().getByTestId('auto-accept-notice')).toBeVisible();
  await expect(form().getByTestId('native-tools-warning')).toHaveCount(0);
  await expect(form().getByTestId('api-key')).toHaveCount(0);
  await expect(form().getByTestId('name')).toHaveValue('Claude Code');

  await form().getByTestId('detect-binary').click();
  await expect(form().getByTestId('detect-status')).toHaveAttribute('data-state', 'done');
  await expect(form().getByTestId('detect-status')).toContainText('9.9.9 (Fake Claude Code)');
  await expect(form().getByTestId('binary-path')).toHaveValue(join(binDir, 'claude'));

  await form().getByTestId('extra-args').fill('--effort\nlow');
  await form().getByTestId('form-test').click();
  await expect(form().getByTestId('form-test-result')).toHaveAttribute('data-ok', 'true', {
    timeout: 20_000,
  });

  await form().getByTestId('save').click();
  await expect(form()).toHaveCount(0);
  await expect(row('Claude Code')).toBeVisible();
  await expect(row('Claude Code').getByTestId('provider-icon')).toHaveAttribute(
    'data-provider',
    'claude-code',
  );
});

test('creates a Codex connection with a sandbox and the native-tools warning', async () => {
  await page.getByTestId('add-connection').first().click();
  await form().getByTestId('provider').selectOption('codex');
  await expect(form().getByTestId('native-tools-warning')).toBeVisible();
  await form().getByTestId('binary-path').fill(bins.codex);
  await form().getByTestId('sandbox').selectOption('read-only');
  await form().getByTestId('working-directory').fill('relative/dir');
  await form().getByTestId('save').click();
  // Relative paths are refused before anything is sent.
  await expect(form()).toBeVisible();
  await form().getByTestId('working-directory').fill('');

  await form().getByTestId('form-test').click();
  await expect(form().getByTestId('form-test-result')).toHaveAttribute('data-ok', 'true', {
    timeout: 20_000,
  });
  await form().getByTestId('save').click();
  await expect(row('Codex')).toBeVisible();

  // Testing from the list records the result.
  await row('Codex').getByTestId('test').click();
  await expect(row('Codex').getByTestId('last-test')).toHaveAttribute('data-ok', 'true', {
    timeout: 20_000,
  });

  // Editing keeps the harness settings.
  await row('Codex').getByTestId('edit').click();
  await expect(form().getByTestId('provider')).toBeDisabled();
  await expect(form().getByTestId('sandbox')).toHaveValue('read-only');
  await expect(form().getByTestId('binary-path')).toHaveValue(bins.codex);
  await form().getByTestId('cancel').click();
});

test('explains a missing binary and a missing login', async () => {
  await page.getByTestId('add-connection').first().click();
  await form().getByTestId('provider').selectOption('claude-code');

  await form().getByTestId('binary-path').fill('/nowhere/claude');
  await form().getByTestId('detect-binary').click();
  await expect(form().getByTestId('detect-status')).toHaveAttribute('data-state', 'failed');

  await form().getByTestId('binary-path').fill(join(binDir, 'claude-logged-out'));
  await form().getByTestId('form-test').click();
  await expect(form().getByTestId('form-test-result')).toHaveAttribute(
    'data-code',
    'not_logged_in',
    { timeout: 20_000 },
  );
  await expect(form().getByTestId('form-test-hint')).toContainText('claude auth login');
  await form().getByTestId('cancel').click();
  await expect(page.getByTestId('connection-row')).toHaveCount(2);
});
