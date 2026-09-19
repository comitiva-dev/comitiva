import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, spawnHarness } from '../../src/providers/cli/process.js';
import { bins } from './helpers.js';
const dir = mkdtempSync(join(tmpdir(), 'comitiva-proc-'));

/** A throwaway executable script. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of lines) out.push(l);
  return out;
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('spawnHarness', () => {
  it('writes the prompt to stdin and yields stdout lines in order, including an unterminated last one', async () => {
    const bin = script(
      'echo-lines',
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('a\\n');process.stdout.write('b'+s.trim()+'\\nla');setTimeout(()=>{process.stdout.write('st');},20)})`,
    );
    const proc = spawnHarness(bin, [], { cwd: dir, env: process.env, stdin: 'X' });
    expect(await collect(proc.lines)).toEqual(['a', 'bX', 'last']);
    expect(await proc.exited).toEqual({ code: 0, signal: null });
  });

  it('keeps the stderr tail and the exit code', async () => {
    const bin = script(
      'fail',
      `process.stderr.write('x'.repeat(20000)+'\\nError: nope\\n');process.exit(3)`,
    );
    const proc = spawnHarness(bin, [], { cwd: dir, env: process.env });
    await collect(proc.lines);
    expect((await proc.exited).code).toBe(3);
    expect(proc.stderrTail().length).toBeLessThanOrEqual(8 * 1024);
    expect(proc.stderrTail()).toContain('Error: nope');
  });

  it('ends with timeout when the harness goes quiet', async () => {
    const bin = script('quiet', `console.log('{}');setInterval(()=>{},1000)`);
    const proc = spawnHarness(bin, [], { cwd: dir, env: process.env, idleTimeoutMs: 200 });
    await expect(collect(proc.lines)).rejects.toMatchObject({ code: 'timeout' });
    expect((await proc.exited).signal).toBe('SIGTERM');
  });

  it('abort kills the whole process group, grandchildren included', async () => {
    const trace = join(dir, 'trace.jsonl');
    const controller = new AbortController();
    const proc = spawnHarness(bins.claude, ['-p'], {
      cwd: dir,
      env: { ...process.env, FAKE_HARNESS_TRACE: trace },
      stdin: '[grandchild] [hang]',
      signal: controller.signal,
    });
    const it = proc.lines[Symbol.asyncIterator]();
    await it.next(); // the init line: the harness is running
    const grandchild = (
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { grandchild?: number })
        .find((t) => t.grandchild) ?? {}
    ).grandchild!;
    expect(pidAlive(grandchild)).toBe(true);
    controller.abort();
    expect((await proc.exited).signal).toBe('SIGTERM');
    await expect.poll(() => pidAlive(grandchild)).toBe(false);
  });

  it('reports a missing binary as binary_not_found', async () => {
    const proc = spawnHarness(join(dir, 'nope'), [], { cwd: dir, env: process.env });
    await expect(collect(proc.lines)).rejects.toMatchObject({ code: 'binary_not_found' });
  });

  it('runCommand collects output and gives up after its timeout', async () => {
    const r = await runCommand(bins.codex, ['--version'], {
      cwd: dir,
      env: process.env,
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ code: 0, stdout: 'codex-cli 9.9.9', timedOut: false });
    const slow = script('slow', `setInterval(()=>{},1000)`);
    const t = await runCommand(slow, [], { cwd: dir, env: process.env, timeoutMs: 200 });
    expect(t.timedOut).toBe(true);
  });
});
