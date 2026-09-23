import { createStore } from 'zustand/vanilla';
import type { AppSettings, AppSettingsPatch, ErrorCode } from '@comitiva/contract';
import { errorCode, type Backend } from '../backend/Backend';

export interface SettingsState {
  settings: AppSettings | null;
  notice: ErrorCode | null;
  load(): Promise<void>;
  update(patch: AppSettingsPatch): Promise<void>;
  dismissNotice(): void;
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

/**
 * App preferences on the Settings screen. `onChange` applies them where they
 * take effect (the UI language).
 */
export function createSettingsStore(
  backend: Backend,
  opts: { onChange?: (settings: AppSettings) => void } = {},
) {
  return createStore<SettingsState>()((set) => {
    const apply = (settings: AppSettings) => {
      set({ settings });
      opts.onChange?.(settings);
    };
    return {
      settings: null,
      notice: null,

      async load() {
        try {
          apply(await backend.settings.get());
        } catch (err) {
          set({ notice: errorCode(err) });
        }
      },

      async update(patch) {
        set({ notice: null });
        try {
          apply(await backend.settings.update(patch));
        } catch (err) {
          set({ notice: errorCode(err) });
        }
      },

      dismissNotice: () => set({ notice: null }),
    };
  });
}
