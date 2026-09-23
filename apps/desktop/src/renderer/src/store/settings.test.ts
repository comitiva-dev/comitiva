import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '../backend/Backend';
import { createSettingsStore } from './settings';
import { fakeBackend } from './testBackend';

describe('settings store', () => {
  it('loads and saves preferences, applying each change', async () => {
    const backend = fakeBackend();
    const onChange = vi.fn();
    const store = createSettingsStore(backend, { onChange });
    await store.getState().load();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'system' }));
    await store.getState().update({ language: 'pt-BR' });
    expect(backend.settings.update).toHaveBeenCalledWith({ language: 'pt-BR' });
    expect(store.getState().settings?.language).toBe('pt-BR');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'pt-BR' }));
  });

  it('keeps the last settings when saving fails', async () => {
    const backend = fakeBackend();
    backend.settings.update.mockRejectedValueOnce(new BackendError('internal', 'x', false));
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().update({ autoUpdate: false });
    expect(store.getState()).toMatchObject({ notice: 'internal', settings: { autoUpdate: true } });
  });
});
