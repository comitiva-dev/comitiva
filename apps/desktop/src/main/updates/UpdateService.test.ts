import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type Timers, type Updater } from './UpdateService';

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  installed = false;
  next: () => Promise<unknown> = () => Promise.resolve();
  checkForUpdates() {
    this.checks += 1;
    return this.next();
  }
  quitAndInstall() {
    this.installed = true;
  }
}

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; every: boolean; id: number }> = [];
  let id = 0;
  const timers: Timers = {
    setTimeout: (fn, ms) => (pending.push({ fn, ms, every: false, id: ++id }), id),
    setInterval: (fn, ms) => (pending.push({ fn, ms, every: true, id: ++id }), id),
    clear: (h) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return { timers, pending };
}

function setup(over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = new FakeUpdater();
  const { timers, pending } = fakeTimers();
  let auto = true;
  const service = new UpdateService({
    updater,
    disabledReason: null,
    currentVersion: '0.1.0',
    autoCheck: () => auto,
    selfInstall: true,
    releaseUrl: (v) => `https://example.test/releases/v${v}`,
    timers,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    ...over,
  });
  const seen: string[] = [];
  service.on('status', (s) => seen.push(s.state));
  return { updater, service, pending, seen, setAuto: (v: boolean) => (auto = v) };
}

describe('UpdateService', () => {
  it('is disabled without an updater, and checking does nothing', async () => {
    const service = new UpdateService({
      updater: null,
      disabledReason: 'development',
      currentVersion: '0.1.0',
      autoCheck: () => true,
      selfInstall: true,
      releaseUrl: () => '',
    });
    expect(service.status()).toMatchObject({ state: 'disabled', disabledReason: 'development' });
    expect((await service.check()).state).toBe('disabled');
    expect(() => service.install()).toThrow();
  });

  it('downloads a newer version and installs it on request', async () => {
    const { updater, service, seen } = setup();
    expect(updater.autoDownload).toBe(true);
    updater.next = async () => {
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '0.2.0' });
    };
    await service.check();
    updater.emit('download-progress', { percent: 42.5 });
    expect(service.status()).toMatchObject({
      state: 'downloading',
      percent: 42.5,
      version: '0.2.0',
    });
    expect(() => service.install()).toThrow();
    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(service.status()).toMatchObject({ state: 'ready', version: '0.2.0' });
    service.install();
    expect(updater.installed).toBe(true);
    expect(seen).toEqual(['checking', 'downloading', 'downloading', 'ready']);
  });

  it('only points to the download when the build cannot install itself', async () => {
    const { updater, service } = setup({ selfInstall: false });
    expect(updater.autoDownload).toBe(false);
    updater.next = async () => void updater.emit('update-available', { version: '0.2.0' });
    await service.check();
    expect(service.status()).toMatchObject({
      state: 'available',
      selfInstall: false,
      downloadUrl: 'https://example.test/releases/v0.2.0',
    });
  });

  it('reports failures by code and records when it last checked', async () => {
    const log = vi.fn();
    const { updater, service } = setup({ log });
    updater.next = () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const status = await service.check();
    expect(status).toMatchObject({ state: 'error', error: 'update_failed' });
    expect(status.lastCheckedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERR_NAME_NOT_RESOLVED'));
    updater.next = async () => void updater.emit('update-not-available', { version: '0.1.0' });
    expect((await service.check()).state).toBe('not-available');
  });

  it('checks on a schedule only while automatic checks are on, one check at a time', async () => {
    const { updater, service, pending, setAuto } = setup();
    service.start();
    expect(pending.map((p) => [p.ms, p.every])).toEqual([
      [10_000, false],
      [6 * 60 * 60 * 1000, true],
    ]);
    pending[0]!.fn();
    pending[1]!.fn(); // overlapping: shares the check in flight
    await Promise.resolve();
    expect(updater.checks).toBe(1);
    setAuto(false);
    service.settingsChanged();
    expect(pending).toEqual([]);
  });
});
