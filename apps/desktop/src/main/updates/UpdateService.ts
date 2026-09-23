import { EventEmitter } from 'node:events';
import { AppError, type UpdateStatus } from '@comitiva/contract';

/** The part of electron-updater's `autoUpdater` this service uses (a fake in tests). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'checking-for-update', fn: () => void): unknown;
  on(event: 'update-available', fn: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', fn: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', fn: (info: { version: string }) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface UpdateServiceDeps {
  /** Null when the build cannot update itself (see `disabledReason`). */
  updater: Updater | null;
  disabledReason: UpdateStatus['disabledReason'];
  currentVersion: string;
  /** Whether automatic checks are on (AppSettings.autoUpdate). */
  autoCheck: () => boolean;
  /**
   * Whether this build can install an update itself. An unsigned macOS build
   * cannot (Squirrel.Mac checks the signature): it is told where to download.
   */
  selfInstall: boolean;
  /** The page of a version, for builds that cannot install it themselves. */
  releaseUrl: (version: string) => string;
  log?: (message: string) => void;
  timers?: Timers;
  now?: () => Date;
  startDelayMs?: number;
  intervalMs?: number;
}

/**
 * Checks GitHub Releases for a newer Comitiva (electron-updater), downloads
 * it in the background and installs it on restart. Automatic checks run 10 s
 * after start and every 6 h while `autoCheck()` holds; "Check now" always
 * works. Failures are logged and shown by code (`update_failed`), never as
 * the updater's message.
 */
export class UpdateService extends EventEmitter<{ status: [UpdateStatus] }> {
  private current: UpdateStatus;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private startTimer: unknown = null;
  private intervalTimer: unknown = null;
  private checking: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    super();
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? (() => new Date());
    this.current = {
      state: deps.updater ? 'idle' : 'disabled',
      currentVersion: deps.currentVersion,
      version: null,
      percent: null,
      lastCheckedAt: null,
      selfInstall: deps.selfInstall,
      downloadUrl: null,
      disabledReason: deps.updater ? null : (deps.disabledReason ?? 'unsupported'),
      error: null,
    };
    const u = deps.updater;
    if (!u) return;
    u.autoDownload = deps.selfInstall;
    u.autoInstallOnAppQuit = deps.selfInstall;
    u.on('checking-for-update', () => this.set({ state: 'checking', error: null }));
    u.on('update-not-available', () =>
      this.set({ state: 'not-available', version: null, lastCheckedAt: this.stamp() }),
    );
    u.on('update-available', ({ version }) =>
      this.set({
        state: deps.selfInstall ? 'downloading' : 'available',
        version,
        percent: deps.selfInstall ? 0 : null,
        lastCheckedAt: this.stamp(),
        downloadUrl: deps.selfInstall ? null : deps.releaseUrl(version),
      }),
    );
    u.on('download-progress', ({ percent }) =>
      this.set({ state: 'downloading', percent: Math.max(0, Math.min(100, percent)) }),
    );
    u.on('update-downloaded', ({ version }) => this.set({ state: 'ready', version, percent: 100 }));
    u.on('error', (err) => {
      deps.log?.(`update failed: ${err.message}`);
      this.set({ state: 'error', error: 'update_failed', percent: null });
    });
  }

  status(): UpdateStatus {
    return this.current;
  }

  /** Starts the automatic checks, if they are on. */
  start(): void {
    this.schedule();
  }

  /** Call when AppSettings.autoUpdate changes. */
  settingsChanged(): void {
    this.schedule();
  }

  stop(): void {
    this.unschedule();
  }

  /** Checks now. Resolves with the status once the check itself is answered. */
  check(): Promise<UpdateStatus> {
    const u = this.deps.updater;
    if (!u) return Promise.resolve(this.current);
    // A download in progress or waiting for a restart is not interrupted.
    if (this.current.state === 'downloading' || this.current.state === 'ready') {
      return Promise.resolve(this.current);
    }
    this.checking ??= u
      .checkForUpdates()
      .then(
        () => this.current,
        (err: unknown) => {
          this.deps.log?.(
            `update check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.set({ state: 'error', error: 'update_failed', lastCheckedAt: this.stamp() });
          return this.current;
        },
      )
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** Restarts into the downloaded update. */
  install(): void {
    if (!this.deps.updater || this.current.state !== 'ready') {
      throw new AppError('invalid_request', 'No update is ready to install');
    }
    this.deps.updater.quitAndInstall();
  }

  private schedule(): void {
    this.unschedule();
    if (!this.deps.updater || !this.deps.autoCheck()) return;
    this.startTimer = this.timers.setTimeout(
      () => void this.check(),
      this.deps.startDelayMs ?? 10_000,
    );
    this.intervalTimer = this.timers.setInterval(
      () => void this.check(),
      this.deps.intervalMs ?? 6 * 60 * 60 * 1000,
    );
  }

  private unschedule(): void {
    if (this.startTimer !== null) this.timers.clear(this.startTimer);
    if (this.intervalTimer !== null) this.timers.clear(this.intervalTimer);
    this.startTimer = this.intervalTimer = null;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private set(changes: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...changes };
    this.emit('status', this.current);
  }
}
