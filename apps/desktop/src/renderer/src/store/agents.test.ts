import { describe, expect, it } from 'vitest';
import { BackendError } from '../backend/Backend';
import { createAgentsStore } from './agents';
import { agent, fakeBackend } from './testBackend';

const sample = {
  name: 'Assistant',
  avatar: { color: 'indigo' as const, emoji: '🤖' },
  connectionId: 'c1',
  role: 'Be helpful.',
};

describe('agents store', () => {
  it('loads agents and settings, and keeps a still-existing selection', async () => {
    const backend = fakeBackend();
    backend.agents.list.mockResolvedValue([agent('a'), agent('b')]);
    const store = createAgentsStore(backend);
    store.getState().select('b');
    await store.getState().load();
    expect(store.getState()).toMatchObject({
      loaded: true,
      selectedId: 'b',
      settings: { sampleAgentOffer: 'pending' },
    });
    backend.agents.list.mockResolvedValue([agent('a')]);
    await store.getState().load();
    expect(store.getState().selectedId).toBeNull();
  });

  it('creates through the editor, selects the new agent and closes', async () => {
    const backend = fakeBackend();
    const store = createAgentsStore(backend);
    store.getState().openCreate();
    await store.getState().save({ draft: sample });
    expect(backend.agents.create).toHaveBeenCalledWith(sample);
    expect(store.getState()).toMatchObject({
      items: [{ id: 'new', name: 'Assistant' }],
      selectedId: 'new',
      editor: { mode: 'closed' },
    });
  });

  it('keeps the editor open and rethrows when saving fails', async () => {
    const backend = fakeBackend();
    backend.agents.update.mockRejectedValue(new BackendError('connection_disabled', 'x', false));
    const store = createAgentsStore(backend);
    store.getState().openEdit('a');
    await expect(store.getState().save({ id: 'a', patch: { model: 'm' } })).rejects.toMatchObject({
      code: 'connection_disabled',
    });
    expect(store.getState().editor).toEqual({ mode: 'edit', id: 'a' });
  });

  it('updates the role in place and rethrows for the inline editor', async () => {
    const backend = fakeBackend();
    backend.agents.list.mockResolvedValue([agent('a')]);
    backend.agents.update.mockResolvedValue(agent('a', { role: 'New' }));
    const store = createAgentsStore(backend);
    await store.getState().load();
    await store.getState().updateRole('a', 'New');
    expect(backend.agents.update).toHaveBeenCalledWith('a', { role: 'New' });
    expect(store.getState().items[0]!.role).toBe('New');

    backend.agents.update.mockRejectedValue(new BackendError('not_found', 'x', false));
    await expect(store.getState().updateRole('a', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('duplicates with the localized name and selects the copy', async () => {
    const backend = fakeBackend();
    const store = createAgentsStore(backend);
    await store.getState().duplicate('a', 'A (cópia)');
    expect(backend.agents.duplicate).toHaveBeenCalledWith('a', 'A (cópia)');
    expect(store.getState()).toMatchObject({ selectedId: 'copy', items: [{ name: 'A (cópia)' }] });
  });

  it('deletes after confirmation and clears the selection', async () => {
    const backend = fakeBackend();
    backend.agents.list.mockResolvedValue([agent('a'), agent('b')]);
    const store = createAgentsStore(backend);
    await store.getState().load();
    store.getState().select('a');
    store.getState().askDelete('a');
    await store.getState().confirmDeletion();
    expect(backend.agents.delete).toHaveBeenCalledWith('a');
    expect(store.getState()).toMatchObject({ selectedId: null, confirmDelete: null });
    expect(store.getState().items.map((x) => x.id)).toEqual(['b']);
  });

  it('shows a failed delete as a notice', async () => {
    const backend = fakeBackend();
    backend.agents.delete.mockRejectedValue(new BackendError('not_found', 'x', false));
    const store = createAgentsStore(backend);
    store.getState().askDelete('a');
    await store.getState().confirmDeletion();
    expect(store.getState().notice).toBe('not_found');
  });

  it('fetches models once per connection, again after a failure or on retry', async () => {
    const backend = fakeBackend();
    const store = createAgentsStore(backend);
    await store.getState().fetchModels('c1');
    await store.getState().fetchModels('c1');
    expect(backend.connections.listModels).toHaveBeenCalledTimes(1);
    expect(backend.connections.listModels).toHaveBeenCalledWith({ id: 'c1' });
    expect(store.getState().models.c1).toEqual({ state: 'done', value: [{ id: 'm1' }] });

    backend.connections.listModels.mockRejectedValueOnce(
      new BackendError('auth_failed', 'x', false),
    );
    await store.getState().fetchModels('c2');
    expect(store.getState().models.c2).toEqual({ state: 'failed', code: 'auth_failed' });
    await store.getState().fetchModels('c2');
    expect(store.getState().models.c2?.state).toBe('done');

    await store.getState().fetchModels('c1', { force: true });
    expect(backend.connections.listModels).toHaveBeenCalledTimes(4);
  });

  it('creates the sample agent and closes the offer', async () => {
    const backend = fakeBackend();
    const store = createAgentsStore(backend);
    await store.getState().load();
    await store.getState().createSample(sample);
    expect(backend.agents.create).toHaveBeenCalledWith(sample);
    expect(backend.settings.update).toHaveBeenCalledWith({ sampleAgentOffer: 'done' });
    expect(store.getState()).toMatchObject({
      selectedId: 'new',
      settings: { sampleAgentOffer: 'done' },
      editor: { mode: 'closed' },
    });
  });

  it('opens the prefilled form when the sample needs a model', async () => {
    const backend = fakeBackend();
    backend.agents.create.mockRejectedValue(new BackendError('model_required', 'x', false));
    const store = createAgentsStore(backend);
    await store.getState().createSample(sample);
    expect(store.getState().editor).toEqual({
      mode: 'create',
      prefill: {
        name: 'Assistant',
        role: 'Be helpful.',
        connectionId: 'c1',
        color: 'indigo',
        emoji: '🤖',
      },
    });
    expect(store.getState().settings).toMatchObject({ sampleAgentOffer: 'done' });
    expect(store.getState().notice).toBeNull();
  });

  it('shows other sample failures as a notice and keeps the offer', async () => {
    const backend = fakeBackend();
    backend.agents.create.mockRejectedValue(new BackendError('connection_disabled', 'x', false));
    const store = createAgentsStore(backend);
    await store.getState().createSample(sample);
    expect(store.getState().notice).toBe('connection_disabled');
    expect(backend.settings.update).not.toHaveBeenCalled();
  });

  it('dismisses the offer for good', async () => {
    const backend = fakeBackend();
    const store = createAgentsStore(backend);
    await store.getState().dismissSample();
    expect(backend.settings.update).toHaveBeenCalledWith({ sampleAgentOffer: 'done' });
    expect(store.getState().settings).toMatchObject({ sampleAgentOffer: 'done' });
  });
});
