import { describe, expect, it } from 'vitest';
import { rangeOf } from '../lib/usage';
import { createUsageStore } from './usage';
import { fakeBackend, usageRow, usageTotals } from './testBackend';

const summary = () => ({
  totals: usageTotals({ runs: 4, costUsd: 1.5 }),
  byConnection: [usageRow({ key: 'c1', label: 'Work' })],
  byAgent: [],
  byModel: [],
});

const fail = (code: string) => Object.assign(new Error(code), { code });

describe('the usage store', () => {
  it('loads the dashboard for the last 30 days by default', async () => {
    const backend = fakeBackend();
    backend.usage.summary.mockResolvedValue(summary());
    const store = createUsageStore(backend);
    expect(store.getState().period).toEqual({ id: 'last30' });

    await store.getState().load();
    expect(store.getState().summary).toMatchObject({ state: 'done' });
    expect(backend.usage.summary).toHaveBeenCalledWith(rangeOf({ id: 'last30' }));
    expect(backend.usage.timeseries).toHaveBeenCalledOnce();
  });

  it('reloads for a new period, with that period window', async () => {
    const backend = fakeBackend();
    const store = createUsageStore(backend);
    await store.getState().setPeriod({ id: 'today' });
    expect(store.getState().period).toEqual({ id: 'today' });
    const sent = backend.usage.summary.mock.calls[0]![0];
    expect(sent).toMatchObject(rangeOf({ id: 'today' }));
  });

  it('keeps the half that worked when one of the two calls fails', async () => {
    const backend = fakeBackend();
    backend.usage.summary.mockResolvedValue(summary());
    backend.usage.timeseries.mockRejectedValue(fail('internal'));
    const store = createUsageStore(backend);

    await store.getState().load();
    expect(store.getState().summary).toMatchObject({ state: 'done' });
    expect(store.getState().series).toEqual({ state: 'failed', code: 'internal' });
  });

  it('reports a failed load by code instead of throwing at the screen', async () => {
    const backend = fakeBackend();
    backend.usage.prices.mockRejectedValue(fail('not_found'));
    const store = createUsageStore(backend);
    await store.getState().loadPrices();
    expect(store.getState().notice).toBe('not_found');
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it('keeps conversation totals per conversation', async () => {
    const backend = fakeBackend();
    backend.usage.conversation.mockImplementation(async (id: string) =>
      usageTotals({ runs: id === 'a' ? 1 : 2 }),
    );
    const store = createUsageStore(backend);
    await store.getState().loadConversation('a');
    await store.getState().loadConversation('b');
    expect(store.getState().byConversation.a?.runs).toBe(1);
    expect(store.getState().byConversation.b?.runs).toBe(2);
  });

  it('remembers where an export went, and that a cancel is not a failure', async () => {
    const backend = fakeBackend();
    const store = createUsageStore(backend);
    await store.getState().exportCsv('records');
    expect(store.getState().lastExport).toEqual({ state: 'done', value: '/tmp/usage.csv' });

    backend.usage.export.mockResolvedValue(null);
    await store.getState().exportCsv('summary');
    expect(store.getState().lastExport).toEqual({ state: 'done', value: null });
  });

  it('exports the period on screen, in the shape asked for', async () => {
    const backend = fakeBackend();
    const store = createUsageStore(backend);
    await store.getState().setPeriod({ id: 'custom', from: '2026-09-01', to: '2026-09-02' });
    await store.getState().exportCsv('summary');
    expect(backend.usage.export).toHaveBeenCalledWith({
      ...rangeOf({ id: 'custom', from: '2026-09-01', to: '2026-09-02' }),
      shape: 'summary',
    });
  });

  it('reports a failed export by code rather than as a notice', async () => {
    const backend = fakeBackend();
    backend.usage.export.mockRejectedValue(fail('internal'));
    const store = createUsageStore(backend);
    await store.getState().exportCsv('records');
    expect(store.getState().lastExport).toEqual({ state: 'failed', code: 'internal' });
    expect(store.getState().notice).toBeNull();
  });

  it('refreshes the dashboard after a price change, because records are recosted', async () => {
    const backend = fakeBackend();
    backend.usage.setPrice.mockResolvedValue([
      { provider: 'anthropic', model: 'm', prices: null, source: 'override', runs: 1 },
    ]);
    const store = createUsageStore(backend);
    await store.getState().savePrice('anthropic', 'm', {
      inputPer1M: 1,
      outputPer1M: 2,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
    expect(store.getState().prices).toMatchObject({ state: 'done' });
    expect(backend.usage.summary).toHaveBeenCalledOnce();
  });

  it('rethrows from the price form, so the form can show the error', async () => {
    const backend = fakeBackend();
    backend.usage.setPrice.mockRejectedValue(fail('invalid_request'));
    const store = createUsageStore(backend);
    await expect(
      store.getState().savePrice('anthropic', 'm', {
        inputPer1M: 1,
        outputPer1M: 2,
        cacheReadPer1M: null,
        cacheWritePer1M: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
