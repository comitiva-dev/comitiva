import { createStore } from 'zustand/vanilla';
import type { ErrorCode, GoogleDriveConfigureInput, GoogleDriveStatus } from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';

export interface GoogleDriveState {
  /** Null until loaded. */
  status: GoogleDriveStatus | null;
  /** An action in flight (connect lasts until the browser comes back). */
  busy: 'connect' | 'disconnect' | null;
  /** Why the last connect or disconnect failed (a cancel is not a failure). */
  notice: ErrorCode | null;
  setupOpen: boolean;
  confirmDisconnect: boolean;

  load(): Promise<void>;
  openSetup(): void;
  closeSetup(): void;
  /** Saves the OAuth client and closes the setup; rejects so the form can show the error. */
  configure(input: GoogleDriveConfigureInput): Promise<void>;
  connect(): Promise<void>;
  cancelConnect(): Promise<void>;
  askDisconnect(): void;
  cancelDisconnect(): void;
  disconnect(): Promise<void>;
  dismissNotice(): void;
}

export type GoogleDriveStore = ReturnType<typeof createGoogleDriveStore>;

/** The Google account behind the built-in Drive server (Tools screen, agent form hint). */
export function createGoogleDriveStore(backend: Backend) {
  return createStore<GoogleDriveState>()((set, get) => ({
    status: null,
    busy: null,
    notice: null,
    setupOpen: false,
    confirmDisconnect: false,

    async load() {
      try {
        set({ status: await backend.googleDrive.getStatus() });
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    },

    openSetup: () => set({ setupOpen: true }),
    closeSetup: () => set({ setupOpen: false }),

    async configure(input) {
      set({ status: await backend.googleDrive.configure(input), setupOpen: false, notice: null });
    },

    async connect() {
      if (get().busy) return;
      const before = get().status;
      set({
        busy: 'connect',
        notice: null,
        ...(before ? { status: { ...before, state: 'connecting' } } : {}),
      });
      try {
        set({ status: await backend.googleDrive.connect() });
      } catch (err) {
        const code = errorCode(err);
        set({ notice: code === 'oauth_cancelled' ? null : code });
        await get().load();
      } finally {
        set({ busy: null });
      }
    },

    async cancelConnect() {
      await backend.googleDrive.cancelConnect();
    },

    askDisconnect: () => set({ confirmDisconnect: true }),
    cancelDisconnect: () => set({ confirmDisconnect: false }),

    async disconnect() {
      set({ confirmDisconnect: false, busy: 'disconnect', notice: null });
      try {
        set({ status: await backend.googleDrive.disconnect() });
      } catch (err) {
        set({ notice: errorCode(err) });
      } finally {
        set({ busy: null });
      }
    },

    dismissNotice: () => set({ notice: null }),
  }));
}
