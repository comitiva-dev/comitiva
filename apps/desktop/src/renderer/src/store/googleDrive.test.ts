import { describe, expect, it } from 'vitest';
import { createGoogleDriveStore } from './googleDrive';
import { driveStatus, fakeBackend } from './testBackend';

const fail = (code: string) => Object.assign(new Error(code), { code });

describe('googleDrive store', () => {
  it('loads, saves the client and connects, showing "connecting" meanwhile', async () => {
    const backend = fakeBackend();
    const store = createGoogleDriveStore(backend);
    await store.getState().load();
    expect(store.getState().status).toEqual(driveStatus());

    store.getState().openSetup();
    await store.getState().configure({ clientId: 'id', clientSecret: { value: 's' } });
    expect(backend.googleDrive.configure).toHaveBeenCalledWith({
      clientId: 'id',
      clientSecret: { value: 's' },
    });
    expect(store.getState()).toMatchObject({
      setupOpen: false,
      status: { clientConfigured: true, hasClientSecret: true },
    });

    let during: unknown;
    backend.googleDrive.connect.mockImplementationOnce(async () => {
      during = store.getState().status?.state;
      return driveStatus({ clientConfigured: true, state: 'connected', email: 'a@b.test' });
    });
    await store.getState().connect();
    expect(during).toBe('connecting');
    expect(store.getState()).toMatchObject({
      busy: null,
      notice: null,
      status: { state: 'connected', email: 'a@b.test' },
    });
  });

  it('keeps the form open when saving fails', async () => {
    const backend = fakeBackend();
    backend.googleDrive.configure.mockRejectedValueOnce(fail('secret_store_unavailable'));
    const store = createGoogleDriveStore(backend);
    store.getState().openSetup();
    await expect(store.getState().configure({ clientId: 'id' })).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(store.getState().setupOpen).toBe(true);
  });

  it('shows why a connect failed, but not a cancel, and reloads the real state', async () => {
    const backend = fakeBackend();
    const store = createGoogleDriveStore(backend);
    backend.googleDrive.connect.mockRejectedValueOnce(fail('oauth_failed'));
    await store.getState().connect();
    expect(store.getState().notice).toBe('oauth_failed');
    expect(store.getState().status?.state).toBe('disconnected');
    expect(store.getState().busy).toBeNull();

    backend.googleDrive.connect.mockRejectedValueOnce(fail('oauth_cancelled'));
    await store.getState().connect();
    expect(store.getState().notice).toBeNull();

    await store.getState().cancelConnect();
    expect(backend.googleDrive.cancelConnect).toHaveBeenCalled();
  });

  it('disconnects after confirmation', async () => {
    const backend = fakeBackend();
    const store = createGoogleDriveStore(backend);
    store.getState().askDisconnect();
    expect(store.getState().confirmDisconnect).toBe(true);
    await store.getState().disconnect();
    expect(backend.googleDrive.disconnect).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      confirmDisconnect: false,
      busy: null,
      status: { state: 'disconnected' },
    });
  });
});
