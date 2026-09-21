import { describe, expect, it } from 'vitest';
import { createAppStore } from './app';
import { fakeBackend } from './testBackend';

describe('app store', () => {
  it('loads version, runner status and secret storage status', async () => {
    const backend = fakeBackend();
    backend.secrets.getStatus.mockResolvedValue({ available: false, weak: false });
    const store = createAppStore(backend);
    await store.getState().init();
    expect(store.getState()).toMatchObject({
      version: '0.1.0',
      runnerStatus: 'ready',
      secretStatus: { available: false },
      section: 'connections',
    });
  });

  it('keeps a pushed runner status over a stale fetched one', async () => {
    const backend = fakeBackend();
    let resolve!: (s: 'starting') => void;
    backend.runner.getStatus.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const store = createAppStore(backend);
    const init = store.getState().init();
    store.getState().handleEvent({ type: 'runner.status', status: 'ready' });
    resolve('starting');
    await init;
    expect(store.getState().runnerStatus).toBe('ready');
  });

  it('switches sections', () => {
    const store = createAppStore(fakeBackend());
    store.getState().setSection('usage');
    expect(store.getState().section).toBe('usage');
  });

  it('lands on a suggested section only until the user navigates', () => {
    const store = createAppStore(fakeBackend());
    store.getState().suggestSection('agents');
    expect(store.getState().section).toBe('agents');
    store.getState().setSection('usage');
    store.getState().suggestSection('agents');
    expect(store.getState().section).toBe('usage');
  });
});
