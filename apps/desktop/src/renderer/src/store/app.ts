import { createStore } from 'zustand/vanilla';
import type { RunnerStatus, SecretStorageStatus } from '@comitiva/contract';
import type { Backend, BackendEvent } from '../backend/Backend';

export type Section = 'agents' | 'connections' | 'tools' | 'usage' | 'settings';

export interface AppState {
  version: string;
  runnerStatus: RunnerStatus;
  /** Null until loaded. */
  secretStatus: SecretStorageStatus | null;
  section: Section;

  init(): Promise<void>;
  setSection(section: Section): void;
  /** Lands on a section at startup, unless the user already navigated. */
  suggestSection(section: Section): void;
  handleEvent(event: BackendEvent): void;
}

export type AppStore = ReturnType<typeof createAppStore>;

/** App-wide state: version, runner status, secret storage, current section. */
export function createAppStore(backend: Backend) {
  return createStore<AppState>()((set) => {
    // A status pushed by an event is always newer than the one init() fetched.
    let runnerStatusFromEvent = false;
    let navigated = false;

    return {
      version: '',
      runnerStatus: 'starting',
      secretStatus: null,
      section: 'connections',

      async init() {
        const [version, runnerStatus, secretStatus] = await Promise.all([
          backend.app.getVersion(),
          backend.runner.getStatus(),
          backend.secrets.getStatus(),
        ]);
        set({ version, secretStatus, ...(runnerStatusFromEvent ? {} : { runnerStatus }) });
      },

      setSection(section) {
        navigated = true;
        set({ section });
      },

      suggestSection(section) {
        if (!navigated) set({ section });
      },

      handleEvent(event) {
        if (event.type === 'runner.status') {
          runnerStatusFromEvent = true;
          set({ runnerStatus: event.status });
        }
      },
    };
  });
}
