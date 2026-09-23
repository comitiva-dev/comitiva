import { describe, expect, it } from 'vitest';
import { PortableBundle } from '../src/index.js';

const bundle = {
  format: 'comitiva.bundle',
  version: 1,
  exportedAt: '2026-09-23T12:00:00.000Z',
  app: { name: 'Comitiva', version: '0.1.0' },
  connections: [
    {
      ref: 'c1',
      name: 'Claude',
      provider: 'anthropic',
      kind: 'api',
      enabled: true,
      config: { defaultModel: 'claude-sonnet-5' },
      hadKey: true,
    },
  ],
  toolServers: [
    {
      ref: 't1',
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'github-mcp'],
      env: { GITHUB_TOKEN: { secret: true }, LOG: { value: 'info' } },
      url: null,
      headers: {},
      enabled: true,
    },
  ],
  agents: [
    {
      name: 'Researcher',
      avatar: { color: 'indigo' },
      connectionRef: 'c1',
      model: null,
      role: 'Research things.',
      params: {},
      tags: [],
      toolServerRefs: ['t1', 'filesystem'],
      roots: [{ path: '/home/me/notes', mode: 'read' }],
      permissionPolicy: 'ask',
    },
  ],
};

describe('PortableBundle', () => {
  it('accepts a bundle with secrets marked but not carried', () => {
    expect(PortableBundle.safeParse(bundle).success).toBe(true);
  });

  it('refuses secret references and values, other formats and versions', () => {
    const withRef = structuredClone(bundle);
    (withRef.toolServers[0]!.env as Record<string, unknown>).GITHUB_TOKEN = { secretRef: 'x' };
    expect(PortableBundle.safeParse(withRef).success).toBe(false);
    expect(PortableBundle.safeParse({ ...bundle, version: 2 }).success).toBe(false);
    expect(PortableBundle.safeParse({ ...bundle, format: 'other' }).success).toBe(false);
  });
});
