import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '@comitiva/contract';
import {
  cliFormFor,
  cliProblems,
  newCliForm,
  parseExtraArgs,
  toCliDraft,
  toCliPatch,
  toCliTarget,
  withCliProvider,
} from './cliConnectionForm';

describe('CLI connection form', () => {
  it('starts with the harness name and no settings', () => {
    const form = newCliForm('claude-code');
    expect(form.name).toBe('Claude Code');
    expect(toCliDraft(form)).toEqual({
      name: 'Claude Code',
      provider: 'claude-code',
      config: { extraArgs: [] },
      enabled: true,
    });
  });

  it('builds a Codex draft with its sandbox and one argument per line', () => {
    const form = {
      ...withCliProvider(newCliForm('claude-code'), 'codex'),
      binaryPath: ' /usr/local/bin/codex ',
      extraArgs: '--search\n\n  -c\nmodel_reasoning_effort="low"  \n',
      workingDirectory: '/home/me/notes',
      defaultModel: 'gpt-5',
      sandbox: 'danger-full-access' as const,
    };
    expect(form.name).toBe('Codex');
    expect(toCliDraft(form)).toEqual({
      name: 'Codex',
      provider: 'codex',
      enabled: true,
      config: {
        binaryPath: '/usr/local/bin/codex',
        extraArgs: ['--search', '-c', 'model_reasoning_effort="low"'],
        workingDirectory: '/home/me/notes',
        defaultModel: 'gpt-5',
        sandbox: 'danger-full-access',
      },
    });
    expect(toCliPatch(form)).toMatchObject({
      name: 'Codex',
      config: { sandbox: 'danger-full-access' },
    });
  });

  it('never sends a key and keeps the typed name when switching harness', () => {
    const form = { ...newCliForm('codex'), name: 'Mine', nameTouched: true };
    expect(withCliProvider(form, 'claude-code').name).toBe('Mine');
    expect(JSON.stringify(toCliDraft(form))).not.toContain('apiKey');
    expect(toCliTarget(form)).toEqual({
      probe: { provider: 'codex', config: { extraArgs: [], sandbox: 'workspace-write' } },
    });
  });

  it('requires a name and absolute paths', () => {
    const form = {
      ...newCliForm('claude-code'),
      name: ' ',
      binaryPath: 'claude',
      workingDirectory: 'notes',
    };
    expect(cliProblems(form)).toEqual(['name', 'binaryPath', 'workingDirectory']);
    expect(toCliTarget(form)).toBeNull();
    expect(
      cliProblems({
        ...form,
        name: 'x',
        binaryPath: 'C:\\tools\\claude.exe',
        workingDirectory: '/home/me/notes',
      }),
    ).toEqual([]);
    expect(
      cliProblems({ ...form, name: 'x', binaryPath: '', workingDirectory: '~/notes' }),
    ).toEqual(['workingDirectory']);
  });

  it('round-trips a saved connection', () => {
    const summary: ConnectionSummary = {
      connection: {
        id: 'c1',
        name: 'Work Codex',
        kind: 'cli',
        provider: 'codex',
        config: { extraArgs: ['--search'], sandbox: 'read-only', workingDirectory: '/w' },
        secretRef: null,
        enabled: true,
        createdAt: '2026-09-18T12:00:00.000Z',
        updatedAt: '2026-09-18T12:00:00.000Z',
      },
      hasSecret: false,
      lastTest: null,
    };
    const form = cliFormFor(summary);
    expect(form).toMatchObject({
      provider: 'codex',
      extraArgs: '--search',
      sandbox: 'read-only',
      workingDirectory: '/w',
    });
    expect(toCliPatch(form).config).toEqual(summary.connection.config);
  });

  it('parses extra args', () => {
    expect(parseExtraArgs('')).toEqual([]);
    expect(parseExtraArgs('a b\n c ')).toEqual(['a b', 'c']);
  });
});
