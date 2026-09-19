import { describe, expect, it } from 'vitest';
import {
  ProviderId,
  apiProviderIds,
  cliProviderDescriptors,
  cliProviderIds,
  providerKind,
  providerDescriptors,
  secretRequirement,
} from '../src/index.js';

describe('provider descriptors', () => {
  it('describes each API provider under its own id', () => {
    for (const id of apiProviderIds) {
      expect(ProviderId.options).toContain(id);
      expect(providerDescriptors[id].id).toBe(id);
      expect(providerDescriptors[id].kind).toBe('api');
    }
    expect([...apiProviderIds].sort()).toEqual([
      'anthropic',
      'google',
      'ollama',
      'openai-compatible',
    ]);
  });

  it('gives every preset a valid base URL, except custom', () => {
    for (const p of providerDescriptors['openai-compatible'].presets) {
      if (p.id === 'custom') expect(p.baseUrl).toBe('');
      else expect(() => new URL(p.baseUrl)).not.toThrow();
    }
  });

  it('resolves the key requirement through presets', () => {
    expect(secretRequirement('anthropic')).toBe('required');
    expect(secretRequirement('openai-compatible', 'lmstudio')).toBe('none');
    expect(secretRequirement('openai-compatible', 'groq')).toBe('required');
    expect(secretRequirement('openai-compatible')).toBe('optional');
    expect(secretRequirement('ollama')).toBe('optional');
  });

  it('describes each CLI harness and derives the kind of every provider', () => {
    expect([...cliProviderIds].sort()).toEqual(['claude-code', 'codex']);
    for (const id of cliProviderIds) {
      expect(cliProviderDescriptors[id].id).toBe(id);
      expect(cliProviderDescriptors[id].kind).toBe('cli');
    }
    expect(cliProviderDescriptors.codex.streaming).toBe('message');
    expect(cliProviderDescriptors.codex.nativeFileToolsDisableable).toBe('never');
    for (const id of ProviderId.options) {
      expect(providerKind(id)).toBe((apiProviderIds as string[]).includes(id) ? 'api' : 'cli');
    }
  });
});
