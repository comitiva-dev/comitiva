import { afterEach, describe, expect, it } from 'vitest';
import type { Block, Message, ToolDef, ToolServerLaunch } from '@comitiva/contract';
import { toToolResult } from '../../src/mcp/content.js';
import { McpClientManager } from '../../src/mcp/McpClientManager.js';
import { ToolCatalog } from '../../src/mcp/ToolCatalog.js';
import { normalizeHistory } from '../../src/runs/history.js';
import { PermissionGate } from '../../src/runs/PermissionGate.js';
import { createFakeMcp } from '../../src/testing/index.js';
import { createLogger } from '../../src/util/logger.js';

const tool = (name: string, annotations?: ToolDef['annotations']): ToolDef => ({
  name,
  inputSchema: { type: 'object' },
  ...(annotations ? { annotations } : {}),
});

describe('PermissionGate', () => {
  const read = tool('read', { readOnlyHint: true });
  const write = tool('write', { readOnlyHint: false, destructiveHint: true });
  const bare = tool('bare');

  it('lets read-only tools run under every policy', () => {
    for (const p of ['ask', 'allow-writes', 'read-only'] as const) {
      expect(new PermissionGate(p).check('s', read)).toBe('allow');
    }
  });

  it('asks for writes and for tools without annotations under ask', () => {
    const g = new PermissionGate('ask');
    expect(g.check('s', write)).toBe('ask');
    expect(g.check('s', bare)).toBe('ask');
  });

  it('refuses writes under read-only, even with a recorded allow-always', () => {
    expect(new PermissionGate('read-only', ['s:write']).check('s', write)).toBe('deny');
  });

  it('allows writes under allow-writes, and a recorded allow-always per server and tool', () => {
    expect(new PermissionGate('allow-writes').check('s', write)).toBe('allow');
    const g = new PermissionGate('ask', ['s:write']);
    expect(g.check('s', write)).toBe('allow');
    expect(g.check('other', write)).toBe('ask');
    g.remember('other', 'write');
    expect(g.check('other', write)).toBe('allow');
  });
});

describe('normalizeHistory', () => {
  const msg = (id: string, role: Message['role'], content: Block[]): Message => ({
    id,
    conversationId: 'c',
    role,
    content,
    status: 'complete',
    seq: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    error: null,
  });
  const use = (id: string): Block => ({
    type: 'tool_use',
    id,
    toolServerId: 's',
    name: 'fs__x',
    input: {},
  });
  const result = (id: string, text = 'ok'): Block => ({
    type: 'tool_result',
    toolUseId: id,
    content: [{ type: 'text', text }],
    isError: false,
  });
  const text = (t: string): Block => ({ type: 'text', text: t });

  it('splits a stored reply with interleaved tool blocks into assistant/tool turns', () => {
    const out = normalizeHistory([
      msg('u', 'user', [text('go')]),
      msg('r', 'assistant', [
        text('a'),
        use('1'),
        result('1'),
        text('b'),
        use('2'),
        result('2'),
        text('c'),
      ]),
    ]);
    expect(out.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['text', 'tool_use']],
      ['tool', ['tool_result']],
      ['assistant', ['text', 'tool_use']],
      ['tool', ['tool_result']],
      ['assistant', ['text']],
    ]);
  });

  it('gives an unfinished tool call an error result and drops orphan results', () => {
    const out = normalizeHistory([
      msg('u', 'user', [text('go')]),
      msg('r', 'assistant', [text('a'), use('1')]),
      msg('u2', 'user', [text('again')]),
      msg('t', 'tool', [result('nope')]),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(out[2]!.content[0]).toMatchObject({ toolUseId: '1', isError: true });
  });

  it('keeps separately stored assistant and tool messages paired', () => {
    const out = normalizeHistory([
      msg('u', 'user', [text('go')]),
      msg('a', 'assistant', [use('1'), use('2')]),
      msg('t', 'tool', [result('2', 'two'), result('1', 'one')]),
    ]);
    expect(out[2]!.content.map((b) => b.type === 'tool_result' && b.toolUseId)).toEqual(['1', '2']);
  });
});

describe('toToolResult', () => {
  it('keeps text and images, notes other content, and caps long text', () => {
    const r = toToolResult({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///x', name: 'x' },
        { type: 'text', text: 'y'.repeat(200_000) },
      ],
    });
    expect(r.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(r.content[1]).toEqual({
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' },
    });
    expect(r.content[2]).toEqual({ type: 'text', text: '[resource: file:///x (x)]' });
    const long = r.content[3] as { text: string };
    expect(long.text.length).toBeLessThan(100_100);
    expect(long.text.endsWith('[output truncated]')).toBe(true);
    expect(toToolResult({ content: [], isError: true })).toEqual({
      content: [{ type: 'text', text: '(no output)' }],
      isError: true,
    });
  });
});

describe('ToolCatalog', () => {
  it('prefixes names, keeps them within provider limits and resolves them', () => {
    const handle = (serverId: string, name: string, tools: ToolDef[], builtin?: 'filesystem') => ({
      serverId,
      name,
      builtin,
      tools,
      call: () => Promise.resolve({ content: [], isError: false }),
      release: () => {},
    });
    const c = new ToolCatalog([
      handle('filesystem', 'Files', [tool('read_file')], 'filesystem'),
      handle('gh', 'GitHub (work)', [tool('create.issue'), tool('x'.repeat(80))]),
    ]);
    const names = c.defs().map((d) => d.name);
    expect(names[0]).toBe('fs__read_file');
    expect(names[1]).toBe('github_work__create_issue');
    expect(names[2]!.length).toBe(64);
    expect(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n))).toBe(true);
    expect(c.resolve('github_work__create_issue')).toMatchObject({
      serverId: 'gh',
      tool: { name: 'create.issue' },
    });
  });
});

describe('McpClientManager', () => {
  const fs: ToolServerLaunch = {
    id: 'filesystem',
    name: 'Files',
    transport: 'stdio',
    command: 'node',
    args: ['fs.cjs'],
    env: {},
    builtin: 'filesystem',
  };
  let mcp: McpClientManager | undefined;
  afterEach(() => mcp?.stopAll());

  it('passes roots and the gate flag to the filesystem server, one instance per set of roots', async () => {
    const fake = createFakeMcp();
    mcp = new McpClientManager(createLogger('silent'), { open: fake.open });
    const a = [{ path: '/a', mode: 'readwrite' as const }];
    const b = [{ path: '/b', mode: 'read' as const }];
    (await mcp.acquire(fs, a)).release();
    (await mcp.acquire(fs, a)).release();
    (await mcp.acquire(fs, b)).release();
    expect(fake.opens()).toBe(2);
    expect(fake.args).toEqual([
      ['--root', '/a:readwrite', '--gated-by-client'],
      ['--root', '/b:read', '--gated-by-client'],
    ]);
    expect(mcp.liveInstances()).toHaveLength(2);
  });

  it('replaces an edited server once nobody holds the old one, and stop closes it for good', async () => {
    const fake = createFakeMcp();
    mcp = new McpClientManager(createLogger('silent'), { open: fake.open });
    const v1: ToolServerLaunch = {
      id: 's',
      name: 'S',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
    };
    const held = await mcp.acquire(v1);
    const v2 = { ...v1, env: { TOKEN: 'new' } };
    (await mcp.acquire(v2)).release();
    // The old instance stays while a run holds it…
    expect(mcp.liveInstances()).toHaveLength(2);
    held.release();
    await expect.poll(() => mcp!.liveInstances().length).toBe(1);

    const again = await mcp.acquire(v2);
    await mcp.stop('s');
    expect(mcp.liveInstances()).toEqual([]);
    // …and a held handle of a stopped server does not bring it back.
    const r = await again.call('read_note', { key: 'a' }, new AbortController().signal);
    expect(r).toMatchObject({ isError: true });
    expect(fake.opens()).toBe(2);
  });
});
