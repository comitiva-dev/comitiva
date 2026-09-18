import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { Database } from './db/Database';
import { ConnectionRepository } from './db/repositories/ConnectionRepository';
import { IpcRouter } from './ipc/IpcRouter';
import { paths } from './paths';
import { RunnerSupervisor } from './runner/RunnerSupervisor';
import { ElectronSecretStore } from './secrets/ElectronSecretStore';
import { ConnectionService } from './services/ConnectionService';

// One data directory named after the product, in dev and packaged builds.
// COMITIVA_USER_DATA isolates e2e runs.
app.setName('Comitiva');
app.setPath('userData', process.env.COMITIVA_USER_DATA ?? join(app.getPath('appData'), 'comitiva'));

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

function isTrustedUrl(url: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith('file://');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Comitiva',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // No in-app navigation or popups; external links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

async function bootstrap(): Promise<void> {
  const db = Database.open(paths.database());
  db.migrate(paths.migrations());

  // Without an OS keyring (Linux basic_text) Chromium can only obfuscate, so
  // the SecretStore refuses to store keys (SPEC §7) and the UI explains why.
  // Tests and CI opt in to obfuscated storage explicitly.
  const allowWeak = process.env.COMITIVA_ALLOW_WEAK_SECRET_STORAGE === '1';
  if (
    allowWeak &&
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    safeStorage.setUsePlainTextEncryption(true);
  }
  const secrets = new ElectronSecretStore(paths.secrets(), safeStorage, { allowWeak });
  if (!secrets.status().available) {
    console.warn('Secure storage is unavailable: API keys cannot be saved on this system');
  }

  const supervisor = new RunnerSupervisor({
    runnerEntry: paths.runnerEntry(),
    logFile: paths.log('runner.log'),
  });

  const connections = new ConnectionService({
    repo: new ConnectionRepository(db),
    secrets,
    runner: supervisor.client,
  });

  const router = new IpcRouter(
    {
      'app.getVersion': () => app.getVersion(),
      'runner.getStatus': () => ({ status: supervisor.status }),
      'secrets.getStatus': () => secrets.status(),
      'connections.list': () => connections.list(),
      'connections.create': (draft) => connections.create(draft),
      'connections.update': ({ id, patch }) => connections.update(id, patch),
      'connections.delete': ({ id }) => connections.delete(id),
      'connections.test': (target) => connections.test(target),
      'connections.listModels': (target) => connections.listModels(target),
    },
    isTrustedUrl,
  );
  router.register();
  supervisor.on('status', (status) => router.broadcast('runner.status', { status }));

  createWindow();
  await supervisor.start();

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void supervisor.stop().finally(() => {
      db.close();
      app.quit();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

void app.whenReady().then(bootstrap);
