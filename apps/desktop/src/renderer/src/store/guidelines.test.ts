import { describe, expect, it } from 'vitest';
import { createGuidelinesStore } from './guidelines';
import { fakeBackend, guideline } from './testBackend';

describe('guidelines store', () => {
  it('loads, saves, moves and deletes guidelines', async () => {
    const backend = fakeBackend();
    backend.guidelines.list.mockResolvedValue([guideline('a'), guideline('b', { position: 1 })]);
    const store = createGuidelinesStore(backend);
    await store.getState().load();
    expect(store.getState().items.map((g) => g.id)).toEqual(['a', 'b']);

    store.getState().openCreate();
    await store.getState().save({ draft: { name: 'Tone' } });
    expect(backend.guidelines.create).toHaveBeenCalledWith({ name: 'Tone' });
    expect(store.getState().items.map((g) => g.id)).toEqual(['a', 'b', 'new']);
    expect(store.getState().editor).toEqual({ mode: 'closed' });

    backend.guidelines.move.mockResolvedValue([guideline('b'), guideline('a'), guideline('new')]);
    await store.getState().move('b', -1);
    expect(backend.guidelines.move).toHaveBeenCalledWith('b', 0);
    expect(store.getState().items.map((g) => g.id)).toEqual(['b', 'a', 'new']);
    // Already first: nothing to do.
    await store.getState().move('b', -1);
    expect(backend.guidelines.move).toHaveBeenCalledTimes(1);

    backend.guidelines.list.mockResolvedValue([guideline('a')]);
    store.getState().askDelete('b');
    await store.getState().confirmDeletion();
    expect(backend.guidelines.delete).toHaveBeenCalledWith('b');
    expect(store.getState().items.map((g) => g.id)).toEqual(['a']);
  });

  it('reports what an import or export did, and failures as a notice', async () => {
    const backend = fakeBackend();
    const store = createGuidelinesStore(backend);
    await store.getState().importFile();
    expect(store.getState().feedback).toBeNull();

    backend.guidelines.import.mockResolvedValue([guideline('x'), guideline('y')]);
    await store.getState().importFile();
    expect(store.getState().items.map((g) => g.id)).toEqual(['x', 'y']);
    expect(store.getState().feedback).toEqual({ kind: 'imported', count: 2 });

    backend.guidelines.export.mockResolvedValue('/tmp/AGENTS.md');
    await store.getState().exportFile();
    expect(store.getState().feedback).toEqual({ kind: 'exported', path: '/tmp/AGENTS.md' });

    backend.guidelines.import.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'invalid_request' }),
    );
    await store.getState().importFile();
    expect(store.getState()).toMatchObject({ notice: 'invalid_request', feedback: null });
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });
});
