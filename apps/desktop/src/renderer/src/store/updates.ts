import { createStore } from 'zustand/vanilla';
import type { ErrorCode, UpdateStatus } from '@comitiva/contract';
import { errorCode, type Backend, type BackendEvent } from '../backend/Backend';

export interface UpdatesState {
  status: UpdateStatus | null;
  notice: ErrorCode | null;
  load(): Promise<void>;
  check(): Promise<void>;
  install(): Promise<void>;
  handleEvent(event: BackendEvent): void;
}

export type UpdatesStore = ReturnType<typeof createUpdatesStore>;

/** The app's own updates: the status main pushes, "Check now" and "Restart to update". */
export function createUpdatesStore(backend: Backend) {
  return createStore<UpdatesState>()((set) => ({
    status: null,
    notice: null,

    async load() {
      try {
        set({ status: await backend.updates.getStatus() });
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    },

    async check() {
      set({ notice: null });
      try {
        set({ status: await backend.updates.check() });
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    },

    async install() {
      try {
        await backend.updates.install();
      } catch (err) {
        set({ notice: errorCode(err) });
      }
    },

    handleEvent(event) {
      if (event.type === 'updates.status') set({ status: event.status });
    },
  }));
}
