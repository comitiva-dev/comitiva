import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, ToolServerLaunch } from '@comitiva/contract';
import { RunnerClient } from '../../src/client/RunnerClient.js';
import {
  claudeCodeConnection,
  codexConnection,
  testAgent,
  userText,
} from '../../src/testing/index.js';
import { bins } from '../cli/helpers.js';

// CLI harnesses reach the agent's tools through the runner's proxy (ADR 0009):
// fake harness → mcp-proxy.cjs → ToolBridge socket → Run.callTool → gate →
// the real filesystem server.
const binPath = fileURLToPath(new URL('../../dist/bin.cjs', import.meta.url));
const filesystem: ToolServerLaunch = {
  id: 'filesystem',
  name: 'Files',
  transport: 'stdio',
  command: process.execPath,
  args: [createRequire(import.meta.url).resolve('@comitiva/mcp-servers/filesystem-bin')],
  env: {},
  builtin: 'filesystem',
};

let dir: string;
let traceFile: string;
const clients: RunnerClient[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-harness-tools-')));
  traceFile = join(dir, '..', `${dir.split('/').at(-1)}.trace`);
  await writeFile(join(dir, 'notes.txt'), 'plum');
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  await rm(dir, { recursive: true, force: true });
  await rm(traceFile, { force: true });
});

async function started() {
  const client = new RunnerClient({
    spawn: () =>
      spawn(process.execPath, [binPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, FAKE_HARNESS_TRACE: traceFile },
      }),
    requestTimeoutMs: 10_000,
  });
  const events: RunEvent[] = [];
  client.on('run.event', (e) => events.push(e));
  clients.push(client);
  await client.start();
  return { client, of: (runId: string) => events.filter((e) => e.runId === runId) };
}

async function traces(): Promise<Array<{ argv: string[]; cwd: string; mcpTools?: string[] }>> {
  return (await readFile(traceFile, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; mcpTools?: string[] });
}

describe.each([
  { provider: 'claude-code', connection: () => claudeCodeConnection(bins.claude) },
  { provider: 'codex', connection: () => codexConnection(bins.codex) },
] as const)('$provider with tools', ({ provider, connection }) => {
  it('reads through the proxy, asks before a write, and keeps native file tools off', async () => {
    const { client, of } = await started();
    const prompt =
      '[mcp:fs__read_file {"path":"notes.txt"}] [mcp:fs__write_file {"path":"out.txt","content":"ok"}]';
    const { runId } = client.startRun({
      conversationId: `c-${provider}`,
      agent: testAgent({ model: null, roots: [{ path: dir, mode: 'readwrite' }] }),
      connection: connection(),
      messages: [userText(`c-${provider}`, prompt)],
      toolServers: [filesystem],
      workingDirectory: join(dir, 'ignored-when-a-root-exists'),
    });

    const call = (name: string) =>
      of(runId).find(
        (e): e is Extract<RunEvent, { type: 'run.tool_call' }> =>
          e.type === 'run.tool_call' && e.toolName === name,
      );
    await expect.poll(() => call('write_file'), { timeout: 10_000 }).toBeDefined();
    expect(call('read_file')).toMatchObject({
      toolServerId: 'filesystem',
      requiresApproval: false,
    });
    expect(call('write_file')).toMatchObject({ requiresApproval: true });
    expect(existsSync(join(dir, 'out.txt'))).toBe(false);
    client.approve(runId, call('write_file')!.toolUseId, 'allow');

    await expect.poll(() => of(runId).at(-1)?.type, { timeout: 10_000 }).toBe('run.done');
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('ok');

    // The run reports each call once, as canonical blocks; the harness's own copy is dropped.
    const uses = of(runId).flatMap((e) =>
      e.type === 'run.block' && e.block.type === 'tool_use' ? [e.block] : [],
    );
    expect(uses.map((u) => [u.name, u.toolServerId])).toEqual([
      ['fs__read_file', 'filesystem'],
      ['fs__write_file', 'filesystem'],
    ]);
    // Claude Code tags calls with its tool-use id; the run keeps it.
    if (provider === 'claude-code') expect(uses[0]!.id).toBe('toolu_mcp_0');
    const results = of(runId).filter((e) => e.type === 'run.tool_result');
    expect(results.map((r) => r.type === 'run.tool_result' && r.isError)).toEqual([false, false]);
    const text = of(runId)
      .flatMap((e) => (e.type === 'run.text_delta' ? [e.text] : []))
      .join('');
    expect(text).toMatch(/^Result: Created\s/);

    const turn = (await traces()).find((t) => t.mcpTools)!;
    expect(turn.cwd).toBe(dir);
    expect(turn.mcpTools).toContain('fs__write_file');
    if (provider === 'claude-code') {
      expect(turn.argv.join(' ')).toContain('--tools WebSearch,WebFetch');
      expect(turn.argv).toContain('--mcp-config');
    } else {
      expect(turn.argv).toContain('sandbox_mode="read-only"');
      expect(turn.argv.some((a) => a.startsWith('mcp_servers.comitiva.command='))).toBe(true);
      // Codex would decline non-read-only tools itself; the runner is the gate.
      expect(turn.argv).toContain('mcp_servers.comitiva.default_tools_approval_mode="approve"');
    }
    // The per-turn config and token file are gone.
    const configFile = turn.argv[turn.argv.indexOf('--mcp-config') + 1];
    if (configFile) expect(existsSync(configFile)).toBe(false);
  });

  it('denies a write through the proxy', async () => {
    const { client, of } = await started();
    const { runId } = client.startRun({
      conversationId: `d-${provider}`,
      agent: testAgent({ model: null, roots: [{ path: dir, mode: 'readwrite' }] }),
      connection: connection(),
      messages: [userText(`d-${provider}`, '[mcp:fs__delete {"path":"notes.txt"}]')],
      toolServers: [filesystem],
    });
    await expect
      .poll(() => of(runId).find((e) => e.type === 'run.tool_call'), { timeout: 10_000 })
      .toBeDefined();
    const call = of(runId).find((e) => e.type === 'run.tool_call')!;
    client.approve(runId, (call as { toolUseId: string }).toolUseId, 'deny');
    await expect.poll(() => of(runId).at(-1)?.type, { timeout: 10_000 }).toBe('run.done');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    const text = of(runId)
      .flatMap((e) => (e.type === 'run.text_delta' ? [e.text] : []))
      .join('');
    expect(text).toMatch(/^Result: approval_denied: /);
  });
});
