import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { Database } from './db/Database';
import { IpcRouter } from './ipc/IpcRouter';
import { paths } from './paths';
import { RunnerSupervisor } from './runner/RunnerSupervisor';
import { ElectronSecretStore } from './secrets/ElectronSecretStore';
import { SPIKE_DEFAULT_MODEL, SpikeService } from './services/SpikeService';

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

  // Without an OS keyring (Linux basic_text), safeStorage refuses to encrypt and
  // so does the SecretStore. Tests and CI opt in to obfuscated storage explicitly.
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text' &&
    process.env.COMITIVA_ALLOW_WEAK_SECRET_STORAGE === '1'
  ) {
    safeStorage.setUsePlainTextEncryption(true);
  }
  const secrets = new ElectronSecretStore(paths.secrets(), safeStorage);
  if (secrets.isWeak()) {
    console.warn(
      'safeStorage is using the basic_text backend: secrets are only obfuscated on this system',
    );
  }

  const supervisor = new RunnerSupervisor({
    runnerEntry: paths.runnerEntry(),
    logFile: paths.log('runner.log'),
  });

  let router: IpcRouter | null = null;
  const spike = new SpikeService({
    runner: supervisor.client,
    secrets,
    emit: (event) => router?.broadcast('spike.event', event),
    latencyLogFile: paths.log('latency.jsonl'),
    anthropicBaseUrl: process.env.COMITIVA_ANTHROPIC_BASE_URL,
    // Measurement knob for docs/STATUS.md; defaults to DELTA_FLUSH_MS.
    ...(process.env.COMITIVA_DELTA_FLUSH_MS
      ? { flushMs: Number(process.env.COMITIVA_DELTA_FLUSH_MS) }
      : {}),
  });

  router = new IpcRouter(
    {
      'app.getVersion': () => app.getVersion(),
      'runner.getStatus': () => ({ status: supervisor.status }),
      'spike.getState': async () => ({
        hasApiKey: await spike.hasApiKey(),
        defaultModel: SPIKE_DEFAULT_MODEL,
        weakSecretStorage: secrets.isWeak(),
      }),
      'spike.saveApiKey': ({ apiKey }) => spike.saveApiKey(apiKey),
      'spike.testApiKey': () => spike.testApiKey(),
      'spike.send': ({ conversationId, text, model }) => spike.send(conversationId, text, model),
      'spike.cancel': ({ conversationId }) => spike.cancel(conversationId),
      'spike.reset': ({ conversationId }) => spike.reset(conversationId),
      'spike.reportLatency': ({ conversationId, samplesMs }) =>
        spike.reportLatency(conversationId, samplesMs),
    },
    isTrustedUrl,
  );
  router.register();
  supervisor.on('status', (status) => router?.broadcast('runner.status', { status }));

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
