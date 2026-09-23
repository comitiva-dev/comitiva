import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@comitiva/contract';
import { BackendError } from '../backend/Backend';
import { fakeBackend } from './testBackend';
import { createUiStore } from './ui';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const result = (title: string): SearchResult => ({
  conversations: [
    { conversationId: 'c1', agentId: 'a1', title, lastActivityAt: '2026-09-01T00:00:00.000Z' },
  ],
  messages: [],
});

describe('ui store', () => {
  it('keeps only the answer to the latest query', async () => {
    const backend = fakeBackend();
    const slow = deferred<SearchResult>();
    backend.search.query.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(result('new'));
    const store = createUiStore(backend);
    const first = store.getState().runSearch('ol');
    await store.getState().runSearch('new');
    slow.resolve(result('old'));
    await first;
    expect(store.getState().search).toMatchObject({ query: 'new', status: 'ready' });
    expect(store.getState().search.result!.conversations[0]!.title).toBe('new');
  });

  it('clears on an empty query and on close, and reports failures by code', async () => {
    const backend = fakeBackend();
    backend.search.query.mockRejectedValueOnce(new BackendError('internal', 'x', false));
    const store = createUiStore(backend);
    store.getState().openQuickSwitcher();
    await store.getState().runSearch('boom');
    expect(store.getState().search).toMatchObject({ status: 'failed', error: 'internal' });
    await store.getState().runSearch('   ');
    expect(store.getState().search.status).toBe('idle');
    store.getState().closeQuickSwitcher();
    expect(store.getState().quickSwitcherOpen).toBe(false);
    store.getState().setShortcutsOpen(true);
    expect(store.getState().shortcutsOpen).toBe(true);
  });
});
