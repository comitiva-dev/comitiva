import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '@comitiva/contract';
import { summary } from '../store/testBackend';
import {
  formFor,
  newForm,
  problems,
  toDraft,
  toPatch,
  toTarget,
  withProvider,
} from './connectionForm';

describe('connection form logic', () => {
  it('starts with Anthropic, named after the provider, with no endpoint override', () => {
    expect(newForm()).toMatchObject({
      provider: 'anthropic',
      name: 'Anthropic',
      baseUrl: '',
      apiKey: '',
    });
  });

  it('follows the provider and preset until the name is touched', () => {
    let form = withProvider(newForm(), 'openai-compatible', 'groq');
    expect(form).toMatchObject({ name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' });
    form = withProvider(form, 'openai-compatible', 'lmstudio');
    expect(form).toMatchObject({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' });
    form = withProvider({ ...form, name: 'Mine', nameTouched: true }, 'ollama');
    expect(form).toMatchObject({ name: 'Mine', baseUrl: 'http://localhost:11434' });
  });

  it('requires a key only when the provider (or preset) needs one', () => {
    expect(problems(newForm(), false)).toEqual(['apiKey']);
    expect(problems({ ...newForm(), apiKey: 'k' }, false)).toEqual([]);
    expect(problems(withProvider(newForm(), 'openai-compatible', 'lmstudio'), false)).toEqual([]);
    expect(problems(withProvider(newForm(), 'ollama'), false)).toEqual([]);
    // Editing: the stored key counts, unless it is being removed.
    expect(problems(newForm(), true)).toEqual([]);
    expect(problems({ ...newForm(), removeKey: true }, true)).toEqual(['apiKey']);
  });

  it('flags a blank name and a bad base URL', () => {
    const form = {
      ...withProvider(newForm(), 'openai-compatible', 'custom'),
      name: ' ',
      apiKey: 'k',
    };
    expect(problems(form, false)).toEqual(['name', 'baseUrl']);
  });

  it('builds a draft with a trimmed key and only the fields that are set', () => {
    const form = {
      ...withProvider(newForm(), 'openai-compatible', 'groq'),
      apiKey: ' gsk ',
      defaultModel: 'llama',
    };
    expect(toDraft(form)).toEqual({
      name: 'Groq',
      provider: 'openai-compatible',
      config: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq', defaultModel: 'llama' },
      enabled: true,
      apiKey: 'gsk',
    });
    expect(toDraft({ ...newForm(), apiKey: 'k' }).config).toEqual({});
  });

  it('patches: blank key keeps it, a typed key replaces it, remove clears it', () => {
    const form = formFor(summary('a'));
    expect(toPatch(form, true)).toEqual({ name: 'Conn a', config: {} });
    expect(toPatch({ ...form, apiKey: 'new' }, true)).toMatchObject({ apiKey: 'new' });
    expect(toPatch({ ...form, removeKey: true }, true)).toMatchObject({ apiKey: null });
    // Switching to a keyless preset drops a stored key, but never sends null when there is none.
    const openai = summary('b', {
      connection: {
        ...summary('b').connection,
        provider: 'openai-compatible',
        config: { baseUrl: 'https://x.test', preset: 'openai' },
      } as ConnectionSummary['connection'],
    });
    const lm = withProvider(formFor(openai), 'openai-compatible', 'lmstudio');
    expect(toPatch(lm, true)).toMatchObject({ apiKey: null });
    expect(toPatch(lm, false)).not.toHaveProperty('apiKey');
  });

  it('probes with the typed key, or the stored key of the connection being edited', () => {
    const form = formFor(summary('a'));
    expect(toTarget(form, 'a')).toEqual({ id: 'a', probe: { provider: 'anthropic', config: {} } });
    expect(toTarget({ ...form, apiKey: 'typed' }, 'a')).toEqual({
      probe: { provider: 'anthropic', config: {}, apiKey: 'typed' },
    });
    expect(toTarget({ ...form, removeKey: true }, 'a')).toEqual({
      probe: { provider: 'anthropic', config: {} },
    });
    expect(
      toTarget({ ...withProvider(newForm(), 'openai-compatible', 'custom') }, null),
    ).toBeNull();
  });
});
