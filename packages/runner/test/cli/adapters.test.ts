import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection, Message } from '@comitiva/contract';
import type { AdapterEvent, RunContext, RunInput } from '../../src/providers/ProviderAdapter.js';
import { ClaudeCodeAdapter } from '../../src/providers/cli/ClaudeCodeAdapter.js';
import type { CliHarnessAdapter } from '../../src/providers/cli/CliHarnessAdapter.js';
import { CodexAdapter, tomlString } from '../../src/providers/cli/CodexAdapter.js';
import { claudeCodeConnection, codexConnection, userText } from '../../src/testing/index.js';
import { bins, textOf } from './helpers.js';

interface Trace {
  argv: string[];
  cwd: string;
  envKeys: string[];
  stdin?: string;
}

let dir: string;
let tracePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comitiva-cli-'));
  tracePath = join(dir, 'trace.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const traces = (): Trace[] =>
  existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Trace)
    : [];

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FAKE_HARNESS_TRACE: tracePath,
    ANTHROPIC_API_KEY: 'sk-ambient',
    OPENAI_API_KEY: 'sk-ambient',
    ELECTRON_RUN_AS_NODE: '1',
    COMITIVA_RUNNER_LOG: 'debug',
    ...extra,
  };
}

const claude = (extra?: Record<string, string>) =>
  new ClaudeCodeAdapter({ env: env(extra), searchDirs: [] });
const codex = (extra?: Record<string, string>) =>
  new CodexAdapter({ env: env(extra), searchDirs: [] });

const ctx: RunContext = {
  tools: [],
  callTool: () => Promise.reject(new Error('no tools')),
  log: () => {},
};

function input(
  connection: Connection,
  messages: Message[],
  extra: Partial<RunInput> = {},
): RunInput {
  return {
    connection,
    secret: undefined,
    model: '',
    system: 'You are terse.',
    params: {},
    messages,
    harnessSessionId: undefined,
    workingDirectory: join(dir, 'workspaces', 'conv-1'),
    ...extra,
  };
}

async function collect(
  adapter: CliHarnessAdapter,
  i: RunInput,
  signal = new AbortController().signal,
  onEvent?: (e: AdapterEvent) => void,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const e of adapter.run(i, ctx, signal)) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

describe.each([
  { name: 'claude-code', make: claude, conn: () => claudeCodeConnection(bins.claude) },
  { name: 'codex', make: codex, conn: () => codexConnection(bins.codex) },
])('$name adapter against the fake harness', ({ make, conn }) => {
  it('runs a first turn in a new working directory, with a clean env', async () => {
    const events = await collect(make(), input(conn(), [userText('conv-1', 'hello there friend')]));
    expect(events[0]).toMatchObject({ type: 'run.session' });
    expect(textOf(events).replace(/\n\n/g, ' ')).toBe('Echo: hello there friend');
    expect(events.at(-2)).toMatchObject({ type: 'run.usage', estimated: false, outputTokens: 7 });
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });

    const [t] = traces();
    expect(t!.cwd).toBe(join(dir, 'workspaces', 'conv-1'));
    expect(t!.stdin).toBe('hello there friend');
    for (const k of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'ELECTRON_RUN_AS_NODE',
      'COMITIVA_RUNNER_LOG',
    ]) {
      expect(t!.envKeys).not.toContain(k);
    }
    expect(t!.envKeys).toContain('PATH');
  });

  it('resumes with only the new message when the harness has the session', async () => {
    const history = [
      userText('conv-1', 'first', 0),
      { ...userText('conv-1', 'answer', 1), role: 'assistant' as const },
      userText('conv-1', 'second', 2),
    ];
    const events = await collect(make(), input(conn(), history, { harnessSessionId: 'sess-1' }));
    expect(events[0]).toEqual({ type: 'run.session', harnessSessionId: 'sess-1' });
    expect(textOf(events)).toContain('(resumed sess-1)');
    expect(traces()[0]!.stdin).toBe('second');
    expect(traces()[0]!.argv).toContain('sess-1');
  });

  it('replays the history into a new session when there is none', async () => {
    const history = [
      userText('conv-1', 'first', 0),
      { ...userText('conv-1', 'answer', 1), role: 'assistant' as const },
      userText('conv-1', 'second', 2),
    ];
    await collect(make(), input(conn(), history));
    const stdin = traces()[0]!.stdin!;
    expect(stdin).toContain('<user>\nfirst\n</user>');
    expect(stdin).toContain('<assistant>\nanswer\n</assistant>');
    expect(stdin.trim().endsWith('second')).toBe(true);
  });

  it('retries as a replay when the session to resume is gone', async () => {
    const history = [userText('conv-1', 'first', 0), userText('conv-1', 'again', 1)];
    const events = await collect(
      make(),
      input(conn(), history, { harnessSessionId: 'missing-session' }),
    );
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'end_turn' });
    const [lost, replay] = traces();
    expect(lost!.argv).toContain('missing-session');
    expect(replay!.argv).not.toContain('missing-session');
    expect(replay!.stdin).toContain('<user>\nfirst\n</user>');
    const session = events.find((e) => e.type === 'run.session');
    expect(session).not.toMatchObject({ harnessSessionId: 'missing-session' });
  });

  it('streams tool blocks the harness reports', async () => {
    const events = await collect(make(), input(conn(), [userText('conv-1', 'go [tool]')]));
    const blocks = events.flatMap((e) => (e.type === 'run.block' ? [e.block.type] : []));
    expect(blocks).toEqual(['tool_use', 'tool_result']);
  });

  it('cancels mid-stream: estimated usage, done(cancelled), process gone', async () => {
    const controller = new AbortController();
    const events = await collect(
      make(),
      input(conn(), [userText('conv-1', 'one two three four five six [chunks:6] [interval:300]')]),
      controller.signal,
      (e) => {
        if (e.type === 'run.text_delta') controller.abort();
      },
    );
    expect(events.at(-2)).toMatchObject({ type: 'run.usage', estimated: true });
    expect(events.at(-1)).toEqual({ type: 'run.done', stopReason: 'cancelled' });
    expect(textOf(events).length).toBeLessThan('Echo: one two three four five six'.length);
  });

  it('fails a turn without a login with not_logged_in', async () => {
    await expect(
      collect(make({ FAKE_HARNESS_LOGGED_OUT: '1' }), input(conn(), [userText('conv-1', 'hi')])),
    ).rejects.toMatchObject({ code: 'not_logged_in' });
  });

  it('fails when the harness exits early, with its stderr', async () => {
    await expect(
      collect(make(), input(conn(), [userText('conv-1', 'hi [stderr:Error: kaboom] [exit:2]')])),
    ).rejects.toMatchObject({ code: 'provider_error', message: /kaboom/ });
  });

  it('needs a working directory and a user message last', async () => {
    const noDir = input(conn(), [userText('conv-1', 'hi')], { workingDirectory: undefined });
    await expect(collect(make(), noDir)).rejects.toMatchObject({ code: 'invalid_request' });
    const assistantLast = input(conn(), [{ ...userText('conv-1', 'x'), role: 'assistant' }]);
    await expect(collect(make(), assistantLast)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('uses the connection working directory when the run has none', async () => {
    const wd = join(dir, 'fixed');
    const c = conn();
    c.config.workingDirectory = wd;
    await collect(make(), input(c, [userText('conv-1', 'hi')], { workingDirectory: undefined }));
    expect(traces()[0]!.cwd).toBe(wd);
  });

  it('detects the binary and its version', async () => {
    const r = await make().detect(conn().config.binaryPath);
    expect(r.path).toBe(conn().config.binaryPath);
    expect(r.version).toMatch(/9\.9\.9/);
  });

  it('tests the connection: version, login, and a real prompt', async () => {
    const r = await make().testConnection(conn());
    expect(r).toMatchObject({ ok: true });
    const promptRun = traces().find((t) => t.stdin !== undefined)!;
    expect(promptRun.stdin).toContain('OK');
    expect(promptRun.cwd).not.toContain('workspaces');
  });

  it('reports actionable test errors', async () => {
    const missing = conn();
    missing.config.binaryPath = join(dir, 'nope');
    expect(await make().testConnection(missing)).toMatchObject({
      ok: false,
      error: { code: 'binary_not_found', message: expect.stringContaining(join(dir, 'nope')) },
    });
    expect(await make({ FAKE_HARNESS_LOGGED_OUT: '1' }).testConnection(conn())).toMatchObject({
      ok: false,
      error: { code: 'not_logged_in', message: expect.stringMatching(/login/) },
    });
  });
});

describe('Claude Code arguments', () => {
  it('runs print mode with stream JSON, auto-accept and isolation; extra args last', async () => {
    const c = claudeCodeConnection(bins.claude, { extraArgs: ['--effort', 'low'] });
    await collect(claude(), input(c, [userText('conv-1', 'hi')], { model: 'sonnet' }));
    const argv = traces()[0]!.argv;
    expect(argv.slice(0, 11)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--model',
    ]);
    expect(argv).toContain('sonnet');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('You are terse.');
    expect(argv.slice(-2)).toEqual(['--effort', 'low']);
  });

  it('omits --model without a model', async () => {
    await collect(claude(), input(claudeCodeConnection(bins.claude), [userText('conv-1', 'hi')]));
    expect(traces()[0]!.argv).not.toContain('--model');
  });
});

describe('Codex arguments', () => {
  it('runs exec --json isolated, with the sandbox and role as config', async () => {
    const c = codexConnection(bins.codex, { sandbox: 'read-only', extraArgs: ['--search'] });
    await collect(codex(), input(c, [userText('conv-1', 'hi')], { model: 'gpt-x' }));
    expect(traces()[0]!.argv).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-c',
      'sandbox_mode="read-only"',
      '-m',
      'gpt-x',
      '-c',
      'developer_instructions="You are terse."',
      '--search',
      '-',
    ]);
  });

  it('resumes with exec resume <id> -', async () => {
    const c = codexConnection(bins.codex);
    await collect(codex(), input(c, [userText('conv-1', 'hi')], { harnessSessionId: 't-1' }));
    const argv = traces()[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(argv.slice(-2)).toEqual(['t-1', '-']);
  });

  it('checks the sandbox in the connection test, unless it is full access', async () => {
    const broken = codex({ FAKE_HARNESS_SANDBOX_BROKEN: '1' });
    expect(await broken.testConnection(codexConnection(bins.codex))).toMatchObject({
      ok: false,
      error: { code: 'sandbox_unavailable', message: expect.stringContaining('bwrap') },
    });
    expect(
      await broken.testConnection(codexConnection(bins.codex, { sandbox: 'danger-full-access' })),
    ).toMatchObject({ ok: true });
  });

  it('quotes the role as a TOML string', () => {
    expect(tomlString('say "hi"\n\tback\\slash')).toBe('"say \\"hi\\"\\n\\tback\\\\slash"');
  });
});
