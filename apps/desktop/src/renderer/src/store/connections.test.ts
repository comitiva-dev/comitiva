import { describe, expect, it } from 'vitest';
import { BackendError } from '../backend/Backend';
import { createConnectionsStore } from './connections';
import { fakeBackend, summary } from './testBackend';

describe('connections store', () => {
  it('loads the list', async () => {
    const backend = fakeBackend();
    backend.connections.list.mockResolvedValue([summary('a'), summary('b')]);
    const store = createConnectionsStore(backend);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ loaded: true, notice: null });
    expect(store.getState().items.map((i) => i.connection.id)).toEqual(['a', 'b']);
  });

  it('creates through the editor, appends the result and closes', async () => {
    const backend = fakeBackend();
    const store = createConnectionsStore(backend);
    store.getState().openCreate();
    const draft = { name: 'A', provider: 'anthropic' as const, config: {}, apiKey: 'k' };
    await store.getState().save({ draft });
    expect(backend.connections.create).toHaveBeenCalledWith(draft);
    expect(store.getState().items.map((i) => i.connection.id)).toEqual(['new']);
    expect(store.getState().editor).toEqual({ mode: 'closed' });
  });

  it('keeps the editor open and rethrows when saving fails', async () => {
    const backend = fakeBackend();
    backend.connections.update.mockRejectedValue(
      new BackendError('secret_store_unavailable', 'x', false),
    );
    const store = createConnectionsStore(backend);
    store.getState().openEdit('a');
    await expect(store.getState().save({ id: 'a', patch: { apiKey: 'k' } })).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(store.getState().editor).toEqual({ mode: 'edit', id: 'a' });
  });

  it('toggles enabled and replaces the row', async () => {
    const backend = fakeBackend();
    backend.connections.list.mockResolvedValue([summary('a')]);
    backend.connections.update.mockResolvedValue(
      summary('a', { connection: { ...summary('a').connection, enabled: false } }),
    );
    const store = createConnectionsStore(backend);
    await store.getState().load();
    await store.getState().setEnabled('a', false);
    expect(backend.connections.update).toHaveBeenCalledWith('a', { enabled: false });
    expect(store.getState().items[0]!.connection.enabled).toBe(false);
  });

  it('tests a row, then reloads to show the recorded result', async () => {
    const backend = fakeBackend();
    backend.connections.list.mockResolvedValueOnce([summary('a')]).mockResolvedValueOnce([
      summary('a', {
        lastTest: { at: '2026-09-18T12:00:00.000Z', ok: true, latencyMs: 5, errorCode: null },
      }),
    ]);
    const store = createConnectionsStore(backend);
    await store.getState().load();
    const pending = store.getState().test('a');
    expect(store.getState().testing.a).toBe(true);
    await pending;
    expect(backend.connections.test).toHaveBeenCalledWith({ id: 'a' });
    expect(store.getState().testing.a).toBe(false);
    expect(store.getState().items[0]!.lastTest).toMatchObject({ ok: true });
  });

  it('deletes only after confirmation and reports connection_in_use', async () => {
    const backend = fakeBackend();
    backend.connections.list.mockResolvedValue([summary('a'), summary('b')]);
    const store = createConnectionsStore(backend);
    await store.getState().load();

    store.getState().askDelete('a');
    store.getState().cancelDelete();
    expect(backend.connections.delete).not.toHaveBeenCalled();

    store.getState().askDelete('a');
    await store.getState().confirmDeletion();
    expect(backend.connections.delete).toHaveBeenCalledWith('a');
    expect(store.getState().items.map((i) => i.connection.id)).toEqual(['b']);

    backend.connections.delete.mockRejectedValueOnce(
      new BackendError('connection_in_use', 'x', false),
    );
    store.getState().askDelete('b');
    await store.getState().confirmDeletion();
    expect(store.getState().notice).toBe('connection_in_use');
    expect(store.getState().items).toHaveLength(1);
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });
});
