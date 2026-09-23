import { describe, expect, it } from 'vitest';
import { BackendError } from '../backend/Backend';
import { fakeBackend, updateStatus } from './testBackend';
import { createUpdatesStore } from './updates';

describe('updates store', () => {
  it('follows the status main pushes and checks on request', async () => {
    const backend = fakeBackend();
    const store = createUpdatesStore(backend);
    await store.getState().load();
    expect(store.getState().status?.state).toBe('idle');
    store.getState().handleEvent({
      type: 'updates.status',
      status: updateStatus({ state: 'downloading', version: '0.2.0', percent: 10 }),
    });
    expect(store.getState().status).toMatchObject({ state: 'downloading', percent: 10 });
    await store.getState().check();
    expect(store.getState().status?.state).toBe('not-available');
  });

  it('shows a refused install by code', async () => {
    const backend = fakeBackend();
    backend.updates.install.mockRejectedValueOnce(new BackendError('invalid_request', 'x', false));
    const store = createUpdatesStore(backend);
    await store.getState().install();
    expect(store.getState().notice).toBe('invalid_request');
  });
});
