import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Connection } from '@comitiva/contract';
import { resolveWorkingDirectory } from './workingDirectory';

const now = '2026-01-01T00:00:00.000Z';
const cli = (workingDirectory?: string): Connection => ({
  id: 'c1',
  name: 'Claude Code',
  kind: 'cli',
  provider: 'claude-code',
  config: { extraArgs: [], ...(workingDirectory ? { workingDirectory } : {}) },
  secretRef: null,
  enabled: true,
  createdAt: now,
  updatedAt: now,
});

describe('resolveWorkingDirectory', () => {
  const workspaces = join('/data', 'workspaces');

  it('defaults to one directory per conversation under userData', () => {
    expect(resolveWorkingDirectory(cli(), '01JCONV', workspaces)).toBe(join(workspaces, '01JCONV'));
  });

  it('uses the connection directory when set', () => {
    expect(resolveWorkingDirectory(cli('/home/me/notes'), '01JCONV', workspaces)).toBe(
      '/home/me/notes',
    );
  });

  it('never builds a path from an unsafe id, and ignores API connections', () => {
    expect(() => resolveWorkingDirectory(cli(), '../escape', workspaces)).toThrow(/Unsafe/);
    const api = { ...cli(), kind: 'api', provider: 'anthropic', config: {} } as Connection;
    expect(resolveWorkingDirectory(api, '01JCONV', workspaces)).toBeUndefined();
  });
});
