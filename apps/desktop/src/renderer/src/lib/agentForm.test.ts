import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '@comitiva/contract';
import { agent, filesystemServer, summary, toolServer } from '../store/testBackend';
import {
  addRoot,
  addTags,
  agentFormFor,
  connectionGroups,
  initials,
  MAX_TAGS,
  moveRoot,
  newAgentForm,
  offeredToolServers,
  paramsApply,
  problems,
  removeRoot,
  rootsWithoutFiles,
  setRootMode,
  supportsModelList,
  toAgentDraft,
  toAgentPatch,
  toggleToolServer,
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
      roots: [],
      toolServerIds: [],
      permissionPolicy: 'ask',
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
      roots: [],
      toolServerIds: [],
      permissionPolicy: 'ask',
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

describe('agent form: folders and tools', () => {
  const base = () => ({ ...newAgentForm([api('c1', 'm')]), name: 'A' });

  it('adds folders read-write, turning Files on with the first one', () => {
    let form = addRoot(base(), '/home/me/work');
    expect(form.roots).toEqual([{ path: '/home/me/work', mode: 'readwrite' }]);
    expect(form.toolServerIds).toEqual(['filesystem']);
    form = addRoot(form, '/home/me/docs');
    form = addRoot(form, '/home/me/docs');
    expect(form.roots.map((r) => r.path)).toEqual(['/home/me/work', '/home/me/docs']);
    expect(form.toolServerIds).toEqual(['filesystem']);
    // Turning Files off after that is the user's call, flagged by a hint.
    form = toggleToolServer(form, 'filesystem', false);
    expect(rootsWithoutFiles(form)).toBe(true);
    expect(addRoot(form, '/x').toolServerIds).toEqual([]);
  });

  it('changes modes, reorders and removes folders', () => {
    let form = addRoot(addRoot(base(), '/a'), '/b');
    form = setRootMode(form, 1, 'read');
    form = moveRoot(form, 1, -1);
    expect(form.roots).toEqual([
      { path: '/b', mode: 'read' },
      { path: '/a', mode: 'readwrite' },
    ]);
    expect(moveRoot(form, 0, -1)).toBe(form);
    expect(removeRoot(form, 0).roots).toEqual([{ path: '/a', mode: 'readwrite' }]);
  });

  it('sends roots, tools and the policy in drafts and patches', () => {
    const form = { ...addRoot(base(), '/w'), permissionPolicy: 'allow-writes' as const };
    expect(toAgentDraft(form)).toMatchObject({
      roots: [{ path: '/w', mode: 'readwrite' }],
      toolServerIds: ['filesystem'],
      permissionPolicy: 'allow-writes',
    });
    const a = agent('a1', { toolServerIds: ['gh'], roots: [{ path: '/r', mode: 'read' }] });
    expect(agentFormFor(a)).toMatchObject({
      toolServerIds: ['gh'],
      roots: [{ path: '/r', mode: 'read' }],
    });
  });

  it('offers enabled servers plus disabled ones the agent still uses', () => {
    const servers = [
      filesystemServer(),
      toolServer('on'),
      toolServer('off', { enabled: false }),
      toolServer('used', { enabled: false }),
    ];
    expect(offeredToolServers(servers, ['used']).map((s) => s.id)).toEqual([
      'filesystem',
      'on',
      'used',
    ]);
  });
});
