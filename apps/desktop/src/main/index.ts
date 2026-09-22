import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { Database } from './db/Database';
import { AgentRepository } from './db/repositories/AgentRepository';
import { ConnectionRepository } from './db/repositories/ConnectionRepository';
import { ConversationRepository } from './db/repositories/ConversationRepository';
import { MessageRepository } from './db/repositories/MessageRepository';
import { ToolApprovalRepository } from './db/repositories/ToolApprovalRepository';
import { ToolServerRepository } from './db/repositories/ToolServerRepository';
import { SettingsRepository } from './db/repositories/SettingsRepository';
import { UsageRepository } from './db/repositories/UsageRepository';
import { IpcRouter } from './ipc/IpcRouter';
import { GOOGLE_API_BASE_URL, GoogleOAuth, googleEndpoints } from './oauth/GoogleOAuth';
import { paths } from './paths';
import { RunnerSupervisor } from './runner/RunnerSupervisor';
import { ElectronSecretStore } from './secrets/ElectronSecretStore';
import { AgentService } from './services/AgentService';
import { ConnectionService } from './services/ConnectionService';
import { ConversationService } from './services/ConversationService';
import { GoogleDriveService } from './services/GoogleDriveService';
import { TitleService } from './services/TitleService';
import { ToolServerService } from './services/ToolServerService';

// One data directory named after the product, in dev and packaged builds.
// COMITIVA_USER_DATA isolates e2e runs.
app.setName('Comitiva');
app.setPath('userData', process.env.COMITIVA_USER_DATA ?? join(app.getPath('appData'), 'comitiva'));

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

function isTrustedUrl(url: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith('file://');
}

/** Native directory picker, attached to the focused window. */
async function pickFolder(): Promise<string | null> {
  const opts = { properties: ['openDirectory', 'createDirectory'] } as Electron.OpenDialogOptions;
  const win = BrowserWindow.getFocusedWindow();
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
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

  const connectionRepo = new ConnectionRepository(db);
  const connections = new ConnectionService({
    repo: connectionRepo,
    secrets,
    runner: supervisor.client,
  });

  const agentRepo = new AgentRepository(db);
  const agents = new AgentService(agentRepo);
  const settings = new SettingsRepository(db);

  // Google's endpoints; tests and CI point both at a fake server.
  const googleApiBaseUrl = process.env.COMITIVA_GOOGLE_API_BASE_URL;
  const googleDrive = new GoogleDriveService({
    secrets,
    runner: supervisor.client,
    apiBaseUrl: googleApiBaseUrl ?? GOOGLE_API_BASE_URL,
    oauth: new GoogleOAuth({
      endpoints: googleEndpoints(process.env.COMITIVA_GOOGLE_OAUTH_BASE_URL),
      // Looked up at call time, so e2e can stand in for the browser.
      openExternal: (url) => shell.openExternal(url),
    }),
  });

  const toolServers = new ToolServerService({
    repo: new ToolServerRepository(db),
    secrets,
    runner: supervisor.client,
    // The app's own binary in Node mode, like the runner (ADR 0002).
    filesystem: {
      command: process.execPath,
      args: [paths.filesystemServer()],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    googleDrive: {
      command: process.execPath,
      args: [paths.googleDriveServer()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(googleApiBaseUrl ? { GDRIVE_API_BASE_URL: googleApiBaseUrl } : {}),
      },
      accessToken: () => googleDrive.accessToken(),
    },
  });

  const usage = new UsageRepository(db);
  const secretFor = (c: Parameters<ConnectionService['secretFor']>[0]) => connections.secretFor(c);
  const chat = new ConversationService({
    db,
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    usage,
    agents: agentRepo,
    connections: connectionRepo,
    secretFor,
    runner: supervisor.client,
    title: new TitleService({ runner: supervisor.client, usage, secretFor }),
    workspacesDir: paths.workspaces(),
    toolServers,
    approvals: new ToolApprovalRepository(db),
  });
  chat.recover();

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
      'connections.detectBinary': (input) => connections.detectBinary(input),
      'agents.list': () => agents.list(),
      'agents.create': (draft) => agents.create(draft),
      'agents.update': ({ id, patch }) => agents.update(id, patch),
      'agents.delete': ({ id }) => {
        chat.forgetAgent(id);
        agents.delete(id);
      },
      'agents.duplicate': ({ id, name }) => agents.duplicate(id, name),
      'settings.get': () => settings.get(),
      'settings.update': (patch) => settings.update(patch),
      'conversations.list': (filter) => chat.list(filter),
      'conversations.create': ({ agentId }) => chat.create(agentId),
      'conversations.rename': ({ id, title }) => chat.rename(id, title),
      'conversations.archive': ({ id, archived }) => chat.archive(id, archived),
      'conversations.markRead': ({ id }) => chat.markRead(id),
      'messages.list': (input) => chat.listMessages(input),
      'messages.send': ({ conversationId, content }) => chat.sendMessage(conversationId, content),
      'messages.cancel': ({ conversationId }) => chat.cancel(conversationId),
      'messages.retry': ({ conversationId }) => chat.retryLast(conversationId),
      'dialogs.pickFolder': () => pickFolder(),
      'toolServers.list': () => toolServers.list(),
      'toolServers.create': (draft) => toolServers.create(draft),
      'toolServers.update': ({ id, patch }) => toolServers.update(id, patch),
      'toolServers.delete': ({ id }) => toolServers.delete(id),
      'toolServers.test': (target) => toolServers.test(target),
      'googleDrive.getStatus': () => googleDrive.status(),
      'googleDrive.configure': (input) => googleDrive.configure(input),
      'googleDrive.connect': () => googleDrive.connect(),
      'googleDrive.cancelConnect': () => googleDrive.cancelConnect(),
      'googleDrive.disconnect': () => googleDrive.disconnect(),
      'approvals.decide': ({ conversationId, toolUseId, decision }) =>
        chat.decide(conversationId, toolUseId, decision),
    },
    isTrustedUrl,
  );
  router.register();
  supervisor.on('status', (status) => router.broadcast('runner.status', { status }));
  chat.on('conversation.updated', (p) => router.broadcast('conversation.updated', p));
  chat.on('message.updated', (p) => router.broadcast('message.updated', p));
  chat.on('message.delta', (p) => router.broadcast('message.delta', p));
  chat.on('message.block', (p) => router.broadcast('message.block', p));

  createWindow();
  await supervisor.start();

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // Replies still streaming are saved as cancelled before the runner and the DB go away.
    chat.shutdown();
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
