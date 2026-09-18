import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerStatus } from '@comitiva/contract';
import { RunnerSupervisor } from './RunnerSupervisor';

const runnerEntry = require.resolve('@comitiva/runner/bin');
const supervisors: RunnerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

async function make() {
  const dir = await mkdtemp(join(tmpdir(), 'comitiva-sup-'));
  // Tests run under Node, which ignores ELECTRON_RUN_AS_NODE; in the app the
  // command is the Electron binary itself.
  const sup = new RunnerSupervisor({
    runnerEntry,
    logFile: join(dir, 'runner.log'),
    command: process.execPath,
    backoff: { initialMs: 50, maxMs: 200, stableAfterMs: 60_000 },
  });
  const statuses: RunnerStatus[] = [];
  sup.on('status', (s) => statuses.push(s));
  supervisors.push(sup);
  return { sup, statuses, logFile: join(dir, 'runner.log') };
}

describe('RunnerSupervisor', () => {
  it('starts the runner and reports ready', async () => {
    const { sup, statuses } = await make();
    await sup.start();
    expect(sup.status).toBe('ready');
    expect(statuses).toEqual(['starting', 'ready']);
    expect(await sup.client.request({ type: 'ping' })).toMatchObject({ protocolVersion: 1 });
  });

  it('restarts the runner after it dies', async () => {
    const { sup, statuses, logFile } = await make();
    await sup.start();
    // Simulate a crash through the protocol-independent path: kill the process.
    const pid = (sup.client as unknown as { child: { pid: number } }).child.pid;
    process.kill(pid, 'SIGKILL');
    await expect.poll(() => statuses.includes('restarting')).toBe(true);
    await expect.poll(() => sup.status, { timeout: 5000 }).toBe('ready');
    expect(await sup.client.request({ type: 'ping' })).toMatchObject({ protocolVersion: 1 });
    await expect.poll(async () => readFile(logFile, 'utf8')).toMatch(/runner exited/);
  });

  it('stops cleanly without restarting', async () => {
    const { sup, statuses } = await make();
    await sup.start();
    await sup.stop();
    expect(sup.status).toBe('stopped');
    await new Promise((r) => setTimeout(r, 150));
    expect(statuses.at(-1)).toBe('stopped');
    expect(sup.client.running).toBe(false);
  });
});
