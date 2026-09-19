import { describe, expect, it } from 'vitest';
import { ipcEventChannels, ipcEvents, ipcInvoke, ipcInvokeChannels } from '../src/index.js';
import { anthropicConnection } from './fixtures.js';

describe('IPC contract', () => {
  it('lists every invoke channel exactly once', () => {
    expect([...ipcInvokeChannels].sort()).toEqual(Object.keys(ipcInvoke).sort());
  });

  it('lists every event channel exactly once', () => {
    expect([...ipcEventChannels].sort()).toEqual(Object.keys(ipcEvents).sort());
  });

  it('validates connection drafts per provider', () => {
    const schema = ipcInvoke['connections.create'].input;
    expect(
      schema.safeParse({
        name: 'Groq',
        provider: 'openai-compatible',
        config: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq' },
        apiKey: 'k',
      }).success,
    ).toBe(true);
    // openai-compatible needs a base URL; names cannot be blank; keys cannot be empty.
    expect(schema.safeParse({ name: 'x', provider: 'openai-compatible', config: {} }).success).toBe(
      false,
    );
    expect(schema.safeParse({ name: '  ', provider: 'ollama', config: {} }).success).toBe(false);
    expect(
      schema.safeParse({ name: 'x', provider: 'anthropic', config: {}, apiKey: '' }).success,
    ).toBe(false);
  });

  it('accepts CLI drafts without a key and applies their defaults', () => {
    const schema = ipcInvoke['connections.create'].input;
    const codex = schema.parse({ name: 'Codex', provider: 'codex', config: {} });
    expect(codex.config).toEqual({ extraArgs: [], sandbox: 'workspace-write' });
    const claude = schema.parse({
      name: 'Claude Code',
      provider: 'claude-code',
      config: { binaryPath: '/usr/local/bin/claude', extraArgs: ['--effort', 'low'] },
      apiKey: 'ignored',
    });
    // CLI harnesses use their own login: a key is stripped, never stored.
    expect(claude).not.toHaveProperty('apiKey');
    expect(
      schema.safeParse({ name: 'x', provider: 'codex', config: { sandbox: 'yolo' } }).success,
    ).toBe(false);
    // gemini-cli has no adapter yet.
    expect(schema.safeParse({ name: 'x', provider: 'gemini-cli', config: {} }).success).toBe(false);
  });

  it('validates binary detection input', () => {
    const schema = ipcInvoke['connections.detectBinary'].input;
    expect(schema.safeParse({ provider: 'claude-code' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'codex', binaryPath: '/x/codex' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'anthropic' }).success).toBe(false);
  });

  it('requires an id or a probe to test or list models', () => {
    const schema = ipcInvoke['connections.test'].input;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: 'c1' }).success).toBe(true);
    expect(schema.safeParse({ probe: { provider: 'ollama', config: {} } }).success).toBe(true);
  });

  it('strips anything but the declared summary fields from outputs', () => {
    const out = ipcInvoke['connections.list'].output.parse([
      { connection: anthropicConnection, hasSecret: true, lastTest: null, apiKey: 'sk-secret' },
    ]);
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('accepts null to remove a key and rejects empty strings', () => {
    const schema = ipcInvoke['connections.update'].input;
    expect(schema.safeParse({ id: 'c1', patch: { apiKey: null } }).success).toBe(true);
    expect(schema.safeParse({ id: 'c1', patch: { apiKey: '' } }).success).toBe(false);
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
