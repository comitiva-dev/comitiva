import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '@comitiva/contract';
import { agent, summary } from '../store/testBackend';
import {
  addTags,
  agentFormFor,
  connectionGroups,
  initials,
  newAgentForm,
  paramsApply,
  problems,
  supportsModelList,
  toAgentDraft,
  toAgentPatch,
  MAX_TAGS,
} from './agentForm';

const api = (id: string, defaultModel?: string, enabled = true): ConnectionSummary => {
  const s = summary(id);
  return {
    ...s,
    connection: {
      ...s.connection,
      enabled,
      config: defaultModel ? { defaultModel } : {},
    } as ConnectionSummary['connection'],
  };
};

const cli = (id: string, enabled = true): ConnectionSummary => {
  const s = summary(id);
  return {
    ...s,
    connection: {
      ...s.connection,
      kind: 'cli',
      provider: 'claude-code',
      config: { extraArgs: [] },
      secretRef: null,
      enabled,
    } as ConnectionSummary['connection'],
  };
};

describe('agent form', () => {
  it('starts on the first enabled connection, with prefilled fields on top', () => {
    const conns = [api('off', 'm', false), api('on', 'm')];
    expect(newAgentForm(conns)).toMatchObject({ connectionId: 'on', color: 'indigo', emoji: '' });
    expect(newAgentForm(conns, { name: 'Assistant', connectionId: 'off' })).toMatchObject({
      name: 'Assistant',
      connectionId: 'off',
    });
    expect(newAgentForm([]).connectionId).toBe('');
  });

  it('round-trips an agent through the form', () => {
    const a = agent('a', {
      name: 'Writer',
      avatar: { color: 'teal', emoji: '✍️' },
      model: 'gpt-5',
      role: 'Write.',
      params: { temperature: 0.4, maxTokens: 1000, topP: 0.9 },
      tags: ['docs'],
    });
    const form = agentFormFor(a);
    expect(form).toMatchObject({
      emoji: '✍️',
      model: 'gpt-5',
      temperature: '0.4',
      maxTokens: '1000',
    });
    // topP is not in the form but survives an edit.
    expect(toAgentPatch({ ...form, temperature: '' }, a)).toEqual({
      name: 'Writer',
      avatar: { color: 'teal', emoji: '✍️' },
      connectionId: 'c1',
      model: 'gpt-5',
      role: 'Write.',
      params: { maxTokens: 1000, topP: 0.9 },
      tags: ['docs'],
    });
  });

  it('builds drafts with trimmed fields; blank emoji and model mean initials and default', () => {
    const form = { ...newAgentForm([api('c1', 'm')]), name: ' Ada ', emoji: ' ', model: ' ' };
    expect(toAgentDraft(form)).toEqual({
      name: 'Ada',
      avatar: { color: 'indigo' },
      connectionId: 'c1',
      model: null,
      role: '',
      params: {},
      tags: [],
    });
  });

  it('flags missing name, connection and model, and bad params', () => {
    const conns = [api('nomodel'), api('withmodel', 'm'), cli('cc')];
    const base = { ...newAgentForm(conns), name: 'A' };
    expect(problems({ ...base, name: ' ', connectionId: 'gone' }, conns)).toEqual([
      'name',
      'connection',
    ]);
    expect(problems({ ...base, connectionId: 'nomodel' }, conns)).toEqual(['model']);
    expect(problems({ ...base, connectionId: 'nomodel', model: 'x' }, conns)).toEqual([]);
    expect(problems({ ...base, connectionId: 'withmodel' }, conns)).toEqual([]);
    expect(problems({ ...base, connectionId: 'cc' }, conns)).toEqual([]);
    expect(
      problems({ ...base, connectionId: 'withmodel', temperature: '2.5', maxTokens: '1.5' }, conns),
    ).toEqual(['temperature', 'maxTokens']);
    expect(
      problems({ ...base, connectionId: 'withmodel', temperature: 'abc', maxTokens: '0' }, conns),
    ).toEqual(['temperature', 'maxTokens']);
    // Harnesses ignore params, so they are not validated.
    expect(problems({ ...base, connectionId: 'cc', temperature: '9' }, conns)).toEqual([]);
  });

  it('groups enabled connections by kind, keeping the current one even if disabled', () => {
    const conns = [api('a'), api('off', undefined, false), cli('cc'), cli('cxoff', false)];
    const ids = (g: ReturnType<typeof connectionGroups>) => ({
      api: g.api.map((c) => c.id),
      cli: g.cli.map((c) => c.id),
    });
    expect(ids(connectionGroups(conns, null))).toEqual({ api: ['a'], cli: ['cc'] });
    expect(ids(connectionGroups(conns, 'off'))).toEqual({ api: ['a', 'off'], cli: ['cc'] });
  });

  it('lists models and applies params only where the provider supports them', () => {
    expect(supportsModelList(api('a').connection)).toBe(true);
    expect(supportsModelList(cli('cc').connection)).toBe(false);
    expect(supportsModelList(undefined)).toBe(false);
    expect(paramsApply(api('a').connection)).toBe(true);
    expect(paramsApply(cli('cc').connection)).toBe(false);
  });

  it('adds tags trimmed, without case duplicates, within limits', () => {
    expect(addTags(['Docs'], ' writing, docs ,, research ')).toEqual([
      'Docs',
      'writing',
      'research',
    ]);
    expect(addTags([], 'x'.repeat(33))).toEqual([]);
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTags(full, 'one-more')).toEqual(full);
  });

  it('makes initials from the first two words', () => {
    expect(initials('research assistant bot')).toBe('RA');
    expect(initials(' Écrivain ')).toBe('É');
    expect(initials('')).toBe('?');
  });
});
