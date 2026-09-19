import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '@comitiva/contract';
import { RunnerClient } from '../../src/client/RunnerClient.js';
import {
  claudeCodeConnection,
  codexConnection,
  testAgent,
  userText,
} from '../../src/testing/index.js';
import { bins } from './helpers.js';

// The whole path for CLI connections: RunnerClient → bundled bin.cjs → adapter → fake harness.
const binPath = fileURLToPath(new URL('../../dist/bin.cjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'comitiva-bin-cli-'));
const clients: RunnerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function newClient() {
  const client = new RunnerClient({
    spawn: () => spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'inherit'] }),
    requestTimeoutMs: 10_000,
  });
  const events: RunEvent[] = [];
  client.on('run.event', (e) => events.push(e));
  clients.push(client);
  await client.start();
  return { client, of: (runId: string) => events.filter((e) => e.runId === runId) };
}

describe.each([
  { provider: 'claude-code', connection: () => claudeCodeConnection(bins.claude) },
  { provider: 'codex', connection: () => codexConnection(bins.codex) },
] as const)('$provider through the runner binary', ({ provider, connection }) => {
  it('detects the binary and tests the connection', async () => {
    const { client } = await newClient();
    const found = await client.detectCli({
      type: 'cli.detect',
      provider,
      binaryPath: connection().config.binaryPath!,
    });
    expect(found.version).toMatch(/9\.9\.9/);
    await expect(
      client.detectCli({ type: 'cli.detect', provider, binaryPath: join(dir, 'missing') }),
    ).rejects.toMatchObject({ code: 'binary_not_found' });
    expect(
      await client.testConnection({ type: 'connection.test', connection: connection() }),
    ).toMatchObject({
      ok: true,
    });
  });

  it('streams a turn, resumes the session, and cancels a third turn', async () => {
    const { client, of } = await newClient();
    const base = {
      conversationId: `conv-${provider}`,
      agent: testAgent({ model: null }),
      connection: connection(),
      workingDirectory: join(dir, provider),
    };

    const first = client.startRun({
      ...base,
      messages: [userText(base.conversationId, 'hello there you')],
    });
    await expect.poll(() => of(first.runId).at(-1)?.type).toBe('run.done');
    const events = of(first.runId);
    const session = events.find((e) => e.type === 'run.session');
    expect(session).toBeDefined();
    expect(events.filter((e) => e.type === 'run.text_delta').length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });

    const sessionId = (session as { harnessSessionId: string }).harnessSessionId;
    const second = client.startRun({
      ...base,
      harnessSessionId: sessionId,
      messages: [userText(base.conversationId, 'again', 2)],
    });
    await expect.poll(() => of(second.runId).at(-1)?.type).toBe('run.done');
    expect(
      of(second.runId)
        .map((e) => (e.type === 'run.text_delta' ? e.text : ''))
        .join(''),
    ).toContain(`(resumed ${sessionId})`);

    const third = client.startRun({
      ...base,
      messages: [userText(base.conversationId, 'a b c d e f g h [chunks:8] [interval:200]', 4)],
    });
    await expect.poll(() => of(third.runId).some((e) => e.type === 'run.text_delta')).toBe(true);
    client.cancelRun(third.runId);
    await expect.poll(() => of(third.runId).at(-1)?.type).toBe('run.done');
    expect(of(third.runId).at(-1)).toMatchObject({ stopReason: 'cancelled' });
    expect(of(third.runId).at(-2)).toMatchObject({ type: 'run.usage', estimated: true });
    expect(client.activeRunIds()).toEqual([]);
  });
});
