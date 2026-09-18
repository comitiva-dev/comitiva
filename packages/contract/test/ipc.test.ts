import { describe, expect, it } from 'vitest';
import { ipcEventChannels, ipcEvents, ipcInvoke, ipcInvokeChannels } from '../src/index.js';

describe('IPC contract', () => {
  it('lists every invoke channel exactly once', () => {
    expect([...ipcInvokeChannels].sort()).toEqual(Object.keys(ipcInvoke).sort());
  });

  it('lists every event channel exactly once', () => {
    expect([...ipcEventChannels].sort()).toEqual(Object.keys(ipcEvents).sort());
  });

  it('validates spike.send input', () => {
    const schema = ipcInvoke['spike.send'].input;
    expect(schema.safeParse({ conversationId: 'a', text: 'hi', model: 'm' }).success).toBe(true);
    expect(schema.safeParse({ conversationId: 'a', text: '', model: 'm' }).success).toBe(false);
  });
});

describe('ipc-channels', () => {
  it('only accepts channel names that exist in the schemas', () => {
    // Compile-time guard: every listed name must be a declared channel.
    const invoke: readonly (keyof typeof ipcInvoke)[] = ipcInvokeChannels;
    const events: readonly (keyof typeof ipcEvents)[] = ipcEventChannels;
    expect(invoke.length + events.length).toBeGreaterThan(0);
  });
});
