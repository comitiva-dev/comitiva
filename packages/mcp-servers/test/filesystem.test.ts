import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemServer, parseArgs } from '../src/filesystem/server.js';
import type { Root } from '../src/filesystem/RootGuard.js';

let base: string;
let work: string;
let docs: string;
let outside: string;
const clients: Client[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-fs-')));
  work = join(base, 'work');
  docs = join(base, 'docs');
  outside = join(base, 'outside');
  for (const d of [work, docs, outside, join(work, 'notes')]) await mkdir(d);
  await writeFile(join(work, 'notes', 'todo.md'), '# Todo\n- buy milk\n- call Ana\n');
  await writeFile(join(work, 'report.txt'), 'Quarterly report\nrevenue up\n');
  await writeFile(join(docs, 'manual.md'), 'Read me\n');
  await writeFile(join(outside, 'secret.txt'), 'top secret');
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await rm(base, { recursive: true, force: true });
});

async function connect(
  roots: Root[] = [
    { path: work, mode: 'readwrite' },
    { path: docs, mode: 'read' },
  ],
  gatedByClient = true,
): Promise<Client> {
  const server = await createFilesystemServer({ roots, gatedByClient });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  return { ...r, text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError ?? false };
}

describe('filesystem server', () => {
  it('lists tools with read-only and destructive annotations', async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(byName).sort()).toEqual(
      ['create_dir', 'delete', 'list_dir', 'move', 'read_file', 'search', 'write_file'].sort(),
    );
    for (const t of ['list_dir', 'read_file', 'search']) expect(byName[t]?.readOnlyHint).toBe(true);
    for (const t of ['write_file', 'move', 'delete']) {
      expect(byName[t]?.readOnlyHint).toBe(false);
      expect(byName[t]?.destructiveHint).toBe(true);
    }
    expect(byName.create_dir?.destructiveHint).toBe(false);
  });

  it('exposes no write tools unless the client gates them, or with only read-only roots', async () => {
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    const ungated = await connect(undefined, false);
    expect(await names(ungated)).toEqual(['list_dir', 'read_file', 'search']);
    const readOnly = await connect([{ path: docs, mode: 'read' }]);
    expect(await names(readOnly)).toEqual(['list_dir', 'read_file', 'search']);
    // Calling a write tool that is not there fails.
    const r = await ungated
      .callTool({ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(r.isError).toBe(true);
    expect(existsSync(join(work, 'x.txt'))).toBe(false);
  });

  it('lists the roots and a folder', async () => {
    const c = await connect();
    const roots = await call(c, 'list_dir', {});
    expect(roots.text).toContain(`${work}/  (read-write)`);
    expect(roots.text).toContain(`${docs}/  (read-only)`);
    const listing = await call(c, 'list_dir', { path: work });
    expect(listing.text).toContain('[dir]  notes/');
    expect(listing.text).toMatch(/\[file\] report\.txt {2}\(\d+ B\)/);
  });

  it('reads text, slices lines, and returns images as image content', async () => {
    const c = await connect();
    expect((await call(c, 'read_file', { path: 'notes/todo.md' })).text).toContain('buy milk');
    const slice = await call(c, 'read_file', { path: 'notes/todo.md', offset: 1, limit: 1 });
    expect(slice.text).toMatch(/^- buy milk\n\n\[showing lines 2–2 of 4/);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await writeFile(join(work, 'pic.png'), png);
    const img = await call(c, 'read_file', { path: 'pic.png' });
    expect(img.content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: png.toString('base64'),
    });
    await writeFile(join(work, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
    expect((await call(c, 'read_file', { path: 'blob.bin' })).text).toMatch(/^invalid_request/);
  });

  it('searches by name and by content', async () => {
    const c = await connect();
    const md = await call(c, 'search', { pattern: '**/*.md' });
    expect(md.text).toContain(join(work, 'notes', 'todo.md'));
    expect(md.text).toContain(join(docs, 'manual.md'));
    const content = await call(c, 'search', { path: work, query: 'REVENUE' });
    expect(content.text).toBe(`${join(work, 'report.txt')}:2: revenue up`);
    expect((await call(c, 'search', { query: 'nothing like this' })).text).toBe('No matches.');
  });

  it('does not follow symlinks out of the roots while searching', async () => {
    await symlink(outside, join(work, 'escape'));
    const c = await connect();
    const r = await call(c, 'search', { query: 'secret' });
    expect(r.text).toBe('No matches.');
  });

  it('writes, creates folders, moves and deletes inside a read-write root', async () => {
    const c = await connect();
    const w = await call(c, 'write_file', { path: 'out/summary.md', content: 'hello' });
    expect(w.text).toContain('Created');
    expect(await readFile(join(work, 'out', 'summary.md'), 'utf8')).toBe('hello');
    expect((await call(c, 'write_file', { path: 'out/summary.md', content: 'v2' })).text).toContain(
      'Replaced',
    );
    await call(c, 'create_dir', { path: 'archive/2026' });
    expect(existsSync(join(work, 'archive', '2026'))).toBe(true);
    const mv = await call(c, 'move', { from: 'report.txt', to: 'archive/2026/report.txt' });
    expect(mv.isError).toBe(false);
    expect(existsSync(join(work, 'archive', '2026', 'report.txt'))).toBe(true);
    const clash = await call(c, 'move', { from: 'out/summary.md', to: 'notes/todo.md' });
    expect(clash.text).toMatch(/^invalid_request: .*already exists/);
    expect((await call(c, 'delete', { path: 'archive' })).text).toMatch(/recursive/);
    await call(c, 'delete', { path: 'archive', recursive: true });
    expect(existsSync(join(work, 'archive'))).toBe(false);
  });

  it('refuses every escape attempt and leaves the outside untouched', async () => {
    await symlink(outside, join(work, 'escape'));
    await symlink(join(outside, 'secret.txt'), join(work, 'secret-link.txt'));
    const c = await connect();
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['read_file', { path: '../outside/secret.txt' }],
      ['read_file', { path: join(outside, 'secret.txt') }],
      ['read_file', { path: 'secret-link.txt' }],
      ['read_file', { path: 'escape/secret.txt' }],
      ['list_dir', { path: 'escape' }],
      ['list_dir', { path: '/' }],
      ['search', { path: '..', query: 'secret' }],
      ['write_file', { path: '../outside/pwned.txt', content: 'x' }],
      ['write_file', { path: 'escape/pwned.txt', content: 'x' }],
      ['write_file', { path: 'secret-link.txt', content: 'x' }],
      ['create_dir', { path: 'escape/newdir' }],
      ['move', { from: 'report.txt', to: '../outside/report.txt' }],
      ['move', { from: 'escape/secret.txt', to: 'stolen.txt' }],
      ['delete', { path: 'escape/secret.txt' }],
      ['delete', { path: '../outside', recursive: true }],
    ];
    for (const [tool, args] of attempts) {
      const r = await call(c, tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text, `${tool} ${JSON.stringify(args)}`).toMatch(/^outside_roots: /);
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
    expect(existsSync(join(outside, 'newdir'))).toBe(false);
    expect(existsSync(join(work, 'report.txt'))).toBe(true);
  });

  it('refuses writes under a read-only root and deleting or moving a root', async () => {
    const c = await connect();
    const r = await call(c, 'write_file', { path: join(docs, 'manual.md'), content: 'x' });
    expect(r.text).toMatch(/^read_only_root: /);
    expect(await readFile(join(docs, 'manual.md'), 'utf8')).toBe('Read me\n');
    expect((await call(c, 'delete', { path: work, recursive: true })).text).toMatch(
      /^invalid_request: A root folder/,
    );
    expect((await call(c, 'move', { from: work, to: join(work, 'x') })).text).toMatch(
      /^invalid_request: A root folder/,
    );
  });

  it('reports missing files as not_found', async () => {
    const c = await connect();
    expect((await call(c, 'read_file', { path: 'nope.txt' })).text).toMatch(/^not_found: /);
  });
});

describe('parseArgs', () => {
  it('parses repeated roots, modes and the gate flag', () => {
    expect(
      parseArgs([
        '--root',
        '/a:readwrite',
        '--root=/b:read',
        '--root',
        'C:\\x:read',
        '--root',
        '/c',
        '--gated-by-client',
      ]),
    ).toEqual({
      roots: [
        { path: '/a', mode: 'readwrite' },
        { path: '/b', mode: 'read' },
        { path: 'C:\\x', mode: 'read' },
        { path: '/c', mode: 'read' },
      ],
      gatedByClient: true,
    });
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
