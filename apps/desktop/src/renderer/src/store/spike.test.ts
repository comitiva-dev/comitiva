import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../backend/Backend';
import { createSpikeStore } from './spike';

function fakeBackend(overrides: Partial<Backend['spike']> = {}) {
  const spike: Backend['spike'] = {
    getState: vi.fn(async () => ({
      hasApiKey: false,
      defaultModel: 'claude-haiku-4-5',
      weakSecretStorage: false,
    })),
    saveApiKey: vi.fn(async () => {}),
    testApiKey: vi.fn(async () => ({ ok: true as const, latencyMs: 5 })),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    reportLatency: vi.fn(async () => {}),
    ...overrides,
  };
  const backend: Backend = {
    app: { getVersion: async () => '0.1.0' },
    runner: { getStatus: async () => 'ready' },
    spike,
    onEvent: () => () => {},
  };
  return backend;
}

/** Runs paint callbacks on demand, with a controllable clock. */
function paintQueue() {
  const queue: Array<() => void> = [];
  return {
    afterPaint: (cb: () => void) => queue.push(cb),
    flush: () => queue.splice(0).forEach((cb) => cb()),
  };
}

describe('spike store', () => {
  it('initializes from the backend', async () => {
    const store = createSpikeStore(fakeBackend());
    await store.getState().init();
    expect(store.getState()).toMatchObject({
      version: '0.1.0',
      runnerStatus: 'ready',
      model: 'claude-haiku-4-5',
    });
  });

  it('clears the key from renderer state once saved', async () => {
    const backend = fakeBackend();
    const store = createSpikeStore(backend);
    store.getState().setApiKeyDraft('  sk-ant-x ');
    await store.getState().saveApiKey();
    expect(backend.spike.saveApiKey).toHaveBeenCalledWith('sk-ant-x');
    expect(store.getState()).toMatchObject({
      apiKeyDraft: '',
      hasApiKey: true,
      keyStatus: 'saved',
    });
  });

  it('routes events to the right pane and keeps panes independent', async () => {
    const paint = paintQueue();
    const store = createSpikeStore(fakeBackend(), {
      afterPaint: paint.afterPaint,
      now: () => 1010,
    });
    const s = store.getState();
    s.setInput('a', 'hello');
    s.setInput('b', 'world');
    await s.send('a');
    await s.send('b');

    s.handleEvent({
      type: 'spike',
      event: { kind: 'delta', conversationId: 'spike-a', text: 'A1 ', runnerTs: 1000 },
    });
    s.handleEvent({
      type: 'spike',
      event: { kind: 'delta', conversationId: 'spike-b', text: 'B1 ', runnerTs: 1004 },
    });
    s.handleEvent({
      type: 'spike',
      event: { kind: 'delta', conversationId: 'spike-a', text: 'A2', runnerTs: 1002 },
    });
    paint.flush();
    s.handleEvent({
      type: 'spike',
      event: { kind: 'done', conversationId: 'spike-a', stopReason: 'cancelled' },
    });
    s.handleEvent({
      type: 'spike',
      event: { kind: 'usage', conversationId: 'spike-b', inputTokens: 3, outputTokens: 7 },
    });

    const { a, b } = store.getState().panes;
    expect(a).toMatchObject({ output: 'A1 A2', status: 'cancelled', samples: [10, 8] });
    expect(b).toMatchObject({
      output: 'B1 ',
      status: 'streaming',
      usage: { inputTokens: 3, outputTokens: 7 },
    });
  });

  it('computes and reports latency when a run ends', async () => {
    const paint = paintQueue();
    const backend = fakeBackend();
    const store = createSpikeStore(backend, { afterPaint: paint.afterPaint, now: () => 1020 });
    store.getState().setInput('a', 'x');
    await store.getState().send('a');
    for (const ts of [1000, 1010, 1015]) {
      store.getState().handleEvent({
        type: 'spike',
        event: { kind: 'delta', conversationId: 'spike-a', text: '.', runnerTs: ts },
      });
    }
    store.getState().handleEvent({
      type: 'spike',
      event: { kind: 'done', conversationId: 'spike-a', stopReason: 'end_turn' },
    });
    paint.flush();
    expect(store.getState().panes.a.latency).toEqual({ n: 3, p50: 10, p95: 20, max: 20 });
    expect(backend.spike.reportLatency).toHaveBeenCalledWith('spike-a', [20, 10, 5]);
  });

  it('shows errors by code and restores the input when send fails', async () => {
    const store = createSpikeStore(
      fakeBackend({
        send: vi.fn(async () =>
          Promise.reject(Object.assign(new Error('x'), { code: 'secret_missing' })),
        ),
      }),
    );
    store.getState().setInput('a', 'hi');
    await store.getState().send('a');
    expect(store.getState().panes.a).toMatchObject({
      status: 'error',
      errorCode: 'secret_missing',
      input: 'hi',
    });
  });
});
