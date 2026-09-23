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

/**
 * Settings: the UI language (system, English, Português) applies at once to
 * the renderer and to main's strings, and survives a restart.
 */

const appDir = join(__dirname, '..');
let userData: string;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

async function launch() {
  app = await electron.launch({
    args: [
      // A known system language, whatever the machine running the tests uses.
      '--lang=en-US',
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: {
      ...process.env,
      LANG: 'en_US.UTF-8',
      LANGUAGE: 'en_US',
      LC_ALL: 'en_US.UTF-8',
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
}

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'comitiva-e2e-settings-'));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
});

test('switches the language and keeps it after a restart', async () => {
  const nav = page.getByTestId('nav-settings');
  await expect(nav).toHaveText('Settings');
  await nav.click();
  await expect(page.getByTestId('settings-language')).toHaveValue('system');

  await page.getByTestId('settings-language').selectOption('pt-BR');
  await expect(nav).toHaveText('Configurações');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.screenshot({ path: join(appDir, 'test-results', 'settings-pt-BR.png') });

  await app.close();
  await launch();
  await expect(page.getByTestId('nav-settings')).toHaveText('Configurações');

  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-language').selectOption('en');
  await expect(page.getByTestId('nav-settings')).toHaveText('Settings');
});
