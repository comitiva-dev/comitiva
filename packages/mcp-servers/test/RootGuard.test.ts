import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardError, RootGuard } from '../src/filesystem/RootGuard.js';

let base: string;
let work: string; // readwrite root
let docs: string; // read root
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-guard-')));
  work = join(base, 'work');
  docs = join(base, 'docs');
  outside = join(base, 'outside');
  for (const d of [work, docs, outside]) await mkdir(d);
  await writeFile(join(work, 'a.txt'), 'a');
  await writeFile(join(outside, 'secret.txt'), 'secret');
});
afterEach(() => rm(base, { recursive: true, force: true }));

const guard = () =>
  RootGuard.create([
    { path: work, mode: 'readwrite' },
    { path: docs, mode: 'read' },
  ]);

async function refused(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e) => e instanceof GuardError && e.code === code);
}

describe('RootGuard', () => {
  it('resolves paths inside the roots, relative ones from the first root', async () => {
    const g = await guard();
    expect((await g.resolve(join(work, 'a.txt'), 'write')).path).toBe(join(work, 'a.txt'));
    expect((await g.resolve('a.txt', 'read')).path).toBe(join(work, 'a.txt'));
    expect((await g.resolve('new/deep/file.md', 'write')).path).toBe(
      join(work, 'new', 'deep', 'file.md'),
    );
    const root = await g.resolve(work, 'read');
    expect(root.isRoot).toBe(true);
  });

  it('refuses .. and absolute paths outside every root', async () => {
    const g = await guard();
    await refused(g.resolve('../outside/secret.txt', 'read'), 'outside_roots');
    await refused(g.resolve(join(work, '..', 'outside', 'secret.txt'), 'read'), 'outside_roots');
    await refused(g.resolve('/etc/passwd', 'read'), 'outside_roots');
    await refused(g.resolve(base, 'read'), 'outside_roots');
    // A sibling whose name starts like the root is not inside it.
    await mkdir(`${work}-evil`);
    await refused(g.resolve(`${work}-evil`, 'read'), 'outside_roots');
  });

  it('refuses a symlinked file that points outside', async () => {
    await symlink(join(outside, 'secret.txt'), join(work, 'link.txt'));
    const g = await guard();
    await refused(g.resolve('link.txt', 'read'), 'outside_roots');
    await refused(g.resolve('link.txt', 'write'), 'outside_roots');
  });

  it('refuses a symlinked folder that points outside, and new files under it', async () => {
    await symlink(outside, join(work, 'escape'));
    const g = await guard();
    await refused(g.resolve('escape/secret.txt', 'read'), 'outside_roots');
    await refused(g.resolve('escape/new.txt', 'write'), 'outside_roots');
    await refused(g.resolve('escape/sub/new.txt', 'write'), 'outside_roots');
  });

  it('refuses a dangling symlink (a write would follow it outside)', async () => {
    await symlink(join(outside, 'not-yet.txt'), join(work, 'dangling.txt'));
    const g = await guard();
    await refused(g.resolve('dangling.txt', 'write'), 'outside_roots');
  });

  it('allows symlinks that stay inside the roots', async () => {
    await symlink(join(work, 'a.txt'), join(work, 'alias.txt'));
    const g = await guard();
    expect((await g.resolve('alias.txt', 'read')).path).toBe(join(work, 'a.txt'));
  });

  it('works when the root itself is a symlink', async () => {
    const linkedRoot = join(base, 'linked-root');
    await symlink(work, linkedRoot);
    const g = await RootGuard.create([{ path: linkedRoot, mode: 'readwrite' }]);
    expect((await g.resolve(join(linkedRoot, 'a.txt'), 'read')).path).toBe(join(work, 'a.txt'));
    await refused(g.resolve(join(linkedRoot, '..', 'outside'), 'read'), 'outside_roots');
  });

  it('refuses writes under a read-only root, and the most specific root wins', async () => {
    const g = await guard();
    await writeFile(join(docs, 'r.txt'), 'r');
    expect((await g.resolve(join(docs, 'r.txt'), 'read')).root.mode).toBe('read');
    await refused(g.resolve(join(docs, 'r.txt'), 'write'), 'read_only_root');
    await refused(g.resolve(join(docs, 'new.txt'), 'write'), 'read_only_root');

    await mkdir(join(work, 'frozen'));
    const nested = await RootGuard.create([
      { path: work, mode: 'readwrite' },
      { path: join(work, 'frozen'), mode: 'read' },
    ]);
    await refused(nested.resolve(join(work, 'frozen', 'x.txt'), 'write'), 'read_only_root');
    expect((await nested.resolve(join(work, 'x.txt'), 'write')).root.mode).toBe('readwrite');
  });

  it('refuses everything without roots and drops roots that do not exist', async () => {
    const warnings: string[] = [];
    const g = await RootGuard.create(
      [
        { path: join(base, 'missing'), mode: 'readwrite' },
        { path: 'relative/dir', mode: 'read' },
      ],
      (m) => warnings.push(m),
    );
    expect(g.roots).toEqual([]);
    expect(warnings).toHaveLength(2);
    await refused(g.resolve('a.txt', 'read'), 'outside_roots');
  });

  it('refuses empty paths and NUL bytes', async () => {
    const g = await guard();
    await refused(g.resolve('  ', 'read'), 'invalid_request');
    await refused(g.resolve('a\0b', 'read'), 'invalid_request');
  });
});
