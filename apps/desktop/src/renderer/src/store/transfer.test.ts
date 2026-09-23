import { describe, expect, it, vi } from 'vitest';
import type { ImportReport } from '@comitiva/contract';
import { BackendError } from '../backend/Backend';
import { fakeBackend } from './testBackend';
import { createTransferStore } from './transfer';

const report: ImportReport = { connections: 1, toolServers: 0, agents: 1, warnings: [] };

describe('transfer store', () => {
  it('confirms where an export went, and a cancel is not an error', async () => {
    const backend = fakeBackend();
    const store = createTransferStore(backend);
    backend.conversations.exportMarkdown.mockResolvedValueOnce('/tmp/a.md');
    await store.getState().exportConversation('k1');
    expect(store.getState()).toMatchObject({ saved: '/tmp/a.md', notice: null, busy: null });
    backend.bundle.export.mockResolvedValueOnce(null);
    await store.getState().exportAgents(['a1']);
    expect(backend.bundle.export).toHaveBeenCalledWith(['a1']);
    expect(store.getState()).toMatchObject({ saved: null, notice: null });
  });

  it('keeps the import report and reloads what it added', async () => {
    const backend = fakeBackend();
    const afterImport = vi.fn();
    const store = createTransferStore(backend, { afterImport });
    backend.bundle.import.mockResolvedValueOnce(report);
    await store.getState().importBundle();
    expect(store.getState().report).toEqual(report);
    expect(afterImport).toHaveBeenCalledOnce();

    backend.bundle.import.mockRejectedValueOnce(new BackendError('invalid_request', 'x', false));
    await store.getState().importBundle();
    expect(store.getState().notice).toBe('invalid_request');
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({ report: null, notice: null });
  });
});
