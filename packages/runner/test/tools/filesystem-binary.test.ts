import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, ToolServerLaunch } from '@comitiva/contract';
import { RunnerClient } from '../../src/client/RunnerClient.js';
import {
  anthropicConnection,
  openaiConnection,
  startFakeProviders,
  testAgent,
  userText,
  type FakeProviders,
} from '../../src/testing/index.js';

// The whole path: RunnerClient → runner binary → MCP client → the real
// filesystem server (dist/filesystem.cjs of @comitiva/mcp-servers) on a temp dir.
const binPath = fileURLToPath(new URL('../../dist/bin.cjs', import.meta.url));
const filesystemBin = createRequire(import.meta.url).resolve(
  '@comitiva/mcp-servers/filesystem-bin',
);

const filesystem: ToolServerLaunch = {
  id: 'filesystem',
  name: 'Files',
  transport: 'stdio',
  command: process.execPath,
  args: [filesystemBin],
  env: {},
  builtin: 'filesystem',
};

let fake: FakeProviders;
let dir: string;
let outside: string;
const clients: RunnerClient[] = [];

beforeAll(async () => {
  fake = await startFakeProviders({ chunks: 2, intervalMs: 1 });
});
afterAll(() => fake.close());
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-run-fs-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'comitiva-outside-')));
  await writeFile(join(dir, 'notes.txt'), 'buy milk');
  await writeFile(join(outside, 'secret.txt'), 'top secret');
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function started() {
  const client = new RunnerClient({
    spawn: () => spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'inherit'] }),
    requestTimeoutMs: 10_000,
  });
  const events: RunEvent[] = [];
  client.on('run.event', (e) => events.push(e));
  clients.push(client);
  await client.start();
  const of = (runId: string) => events.filter((e) => e.runId === runId);
  const find = <T extends RunEvent['type']>(
    runId: string,
    type: T,
    pred: (e: Extract<RunEvent, { type: T }>) => boolean = () => true,
  ) =>
    of(runId).find(
      (e): e is Extract<RunEvent, { type: T }> =>
        e.type === type && pred(e as Extract<RunEvent, { type: T }>),
    );
  return { client, events, of, find };
}

describe('tools through the runner binary and the real filesystem server', () => {
  it('lists the server tools with toolServer.start', async () => {
    const { client } = await started();
    const tools = await client.startToolServer({
      toolServer: filesystem,
      roots: [{ path: dir, mode: 'readwrite' }],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['create_dir', 'delete', 'list_dir', 'move', 'read_file', 'search', 'write_file'].sort(),
    );
    expect(tools.find((t) => t.name === 'read_file')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    await client.stopToolServer('filesystem');
  });

  it.each([
    ['anthropic', () => anthropicConnection(fake.urls.anthropic)],
    ['openai-compatible', () => openaiConnection(fake.urls.openai)],
  ])(
    '%s: reads freely, writes after approval, and is refused outside the root',
    async (_name, connection) => {
      const { client, of, find } = await started();
      const prompt = [
        '[tool:fs__read_file {"path":"notes.txt"}]',
        '[tool:fs__write_file {"path":"out/summary.txt","content":"milk bought"}]',
        `[tool:fs__read_file {"path":"${join(outside, 'secret.txt')}"}]`,
      ].join(' ');
      const { runId } = client.startRun({
        conversationId: 'c1',
        agent: testAgent({ roots: [{ path: dir, mode: 'readwrite' }], model: 'm' }),
        connection: connection(),
        secret: 'sk-test',
        messages: [userText('c1', prompt)],
        toolServers: [filesystem],
      });

      // 1. The read runs without asking.
      await expect.poll(() => find(runId, 'run.tool_result')).toBeDefined();
      expect(find(runId, 'run.tool_call')).toMatchObject({
        toolServerId: 'filesystem',
        toolName: 'read_file',
        requiresApproval: false,
      });
      expect(find(runId, 'run.tool_result')?.output).toEqual([{ type: 'text', text: 'buy milk' }]);

      // 2. The write waits for approval; nothing is written before it.
      await expect
        .poll(() => find(runId, 'run.tool_call', (e) => e.toolName === 'write_file'))
        .toBeDefined();
      const write = find(runId, 'run.tool_call', (e) => e.toolName === 'write_file')!;
      expect(write.requiresApproval).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(join(dir, 'out', 'summary.txt'))).toBe(false);
      client.approve(runId, write.toolUseId, 'allow');

      // 3. The read outside the root is refused by the server.
      await expect.poll(() => of(runId).at(-1)?.type, { timeout: 10_000 }).toBe('run.done');
      expect(await readFile(join(dir, 'out', 'summary.txt'), 'utf8')).toBe('milk bought');
      const results = of(runId).filter((e) => e.type === 'run.tool_result');
      expect(results).toHaveLength(3);
      expect(results[2]).toMatchObject({
        isError: true,
        output: [{ type: 'text', text: expect.stringMatching(/^outside_roots: /) }],
      });
      // The model got the refusal back and answered with it.
      const text = of(runId)
        .flatMap((e) => (e.type === 'run.text_delta' ? [e.text] : []))
        .join('');
      expect(text).toMatch(/^Result: outside_roots: /);
      expect(of(runId).at(-1)).toMatchObject({ stopReason: 'end_turn' });
    },
  );

  it('does not write when the user denies, and cancels cleanly while waiting', async () => {
    const { client, of, find } = await started();
    const base = {
      agent: testAgent({ roots: [{ path: dir, mode: 'readwrite' }] }),
      connection: anthropicConnection(fake.urls.anthropic),
      secret: 'sk-test',
      toolServers: [filesystem],
    };
    const prompt = '[tool:fs__delete {"path":"notes.txt"}]';
    const denied = client.startRun({
      ...base,
      conversationId: 'c1',
      messages: [userText('c1', prompt)],
    });
    await expect.poll(() => find(denied.runId, 'run.tool_call')).toBeDefined();
    client.approve(denied.runId, find(denied.runId, 'run.tool_call')!.toolUseId, 'deny');
    await expect.poll(() => of(denied.runId).at(-1)?.type).toBe('run.done');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(find(denied.runId, 'run.tool_result')).toMatchObject({ isError: true });

    const cancelled = client.startRun({
      ...base,
      conversationId: 'c2',
      messages: [userText('c2', prompt)],
    });
    await expect.poll(() => find(cancelled.runId, 'run.tool_call')).toBeDefined();
    client.cancelRun(cancelled.runId);
    await expect
      .poll(() => of(cancelled.runId).at(-1))
      .toMatchObject({ type: 'run.done', stopReason: 'cancelled' });
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
