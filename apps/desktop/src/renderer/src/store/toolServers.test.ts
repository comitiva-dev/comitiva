import { describe, expect, it } from 'vitest';
import { createToolServersStore } from './toolServers';
import { fakeBackend, filesystemServer, toolServer } from './testBackend';

describe('toolServers store', () => {
  it('loads, toggles, tests and deletes servers', async () => {
    const backend = fakeBackend();
    backend.toolServers.list.mockResolvedValue([filesystemServer(), toolServer('s1')]);
    const store = createToolServersStore(backend);
    await store.getState().load();
    expect(store.getState().items.map((i) => i.id)).toEqual(['filesystem', 's1']);

    backend.toolServers.update.mockResolvedValue(filesystemServer({ enabled: false }));
    await store.getState().setEnabled('filesystem', false);
    expect(backend.toolServers.update).toHaveBeenCalledWith('filesystem', { enabled: false });
    expect(store.getState().items[0]!.enabled).toBe(false);

    await store.getState().test('s1');
    expect(backend.toolServers.test).toHaveBeenCalledWith({ id: 's1' });
    expect(store.getState().tests.s1).toEqual({
      state: 'done',
      value: [{ name: 'read_file', inputSchema: {} }],
    });
    backend.toolServers.test.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'tool_server_failed' }),
    );
    await store.getState().test('s1');
    expect(store.getState().tests.s1).toEqual({ state: 'failed', code: 'tool_server_failed' });

    store.getState().askDelete('s1');
    await store.getState().confirmDeletion();
    expect(backend.toolServers.delete).toHaveBeenCalledWith('s1');
    expect(store.getState().items.map((i) => i.id)).toEqual(['filesystem']);
  });

  it('saves from the editor and surfaces failures to the form', async () => {
    const backend = fakeBackend();
    const store = createToolServersStore(backend);
    store.getState().openCreate();
    await store.getState().save({
      draft: { name: 'New', spec: { transport: 'stdio', command: 'x' } },
    });
    expect(store.getState().editor).toEqual({ mode: 'closed' });
    expect(store.getState().items.map((i) => i.name)).toEqual(['New']);

    backend.toolServers.update.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'secret_store_unavailable' }),
    );
    store.getState().openEdit('new');
    await expect(store.getState().save({ id: 'new', patch: { name: 'x' } })).rejects.toMatchObject({
      code: 'secret_store_unavailable',
    });
    expect(store.getState().editor).toEqual({ mode: 'edit', id: 'new' });
  });

  it('probes unsaved settings without touching the list, and clears a test', async () => {
    const backend = fakeBackend();
    const store = createToolServersStore(backend);
    const spec = { transport: 'stdio' as const, command: 'npx' };
    await expect(store.getState().probe({ spec, id: 's1' })).resolves.toHaveLength(1);
    expect(backend.toolServers.test).toHaveBeenCalledWith({ spec, id: 's1' });
    expect(store.getState().tests).toEqual({});
    await store.getState().test('google-drive');
    store.getState().clearTest('google-drive');
    expect(store.getState().tests['google-drive']).toEqual({ state: 'idle' });
  });
});
