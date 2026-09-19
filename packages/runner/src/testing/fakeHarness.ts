/**
 * Fake CLI harness for tests: built to `dist/testing/bin/fake-claude` and
 * `fake-codex`. It speaks the same line formats as the real binaries
 * (recorded in test/fixtures/, see docs/providers.md), so the adapters and
 * the desktop e2e run the whole path without a real login.
 *
 * Which harness it plays comes from its file name (or FAKE_HARNESS).
 *
 * Prompt controls: `[chunks:N]` splits the reply (Codex: into N messages),
 * `[interval:MS]` waits between chunks, `[tool]` runs a fake tool first,
 * `[stderr:TEXT]` writes to stderr, `[exit:N]` exits with N after the
 * session line, `[hang]` never finishes, `[grandchild]` starts a child that
 * outlives nothing (its pid goes to the trace), `[not-logged-in]` fails auth.
 *
 * Env: FAKE_HARNESS_LOGGED_OUT=1 (auth status and turns fail),
 * FAKE_HARNESS_SANDBOX_BROKEN=1 (codex sandbox probe fails),
 * FAKE_HARNESS_TRACE=<file> (one JSON line per invocation: argv, cwd, env keys, stdin).
 * Resuming the session id `missing-session` behaves like a lost session.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

type Kind = 'claude' | 'codex';

const kind: Kind =
  process.env.FAKE_HARNESS === 'codex' || basename(process.argv[1] ?? '').includes('codex')
    ? 'codex'
    : 'claude';
const argv = process.argv.slice(2);
const loggedOut = process.env.FAKE_HARNESS_LOGGED_OUT === '1';

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trace(extra: Record<string, unknown> = {}): void {
  const file = process.env.FAKE_HARNESS_TRACE;
  if (!file) return;
  appendFileSync(
    file,
    `${JSON.stringify({ kind, argv, cwd: process.cwd(), envKeys: Object.keys(process.env), ...extra })}\n`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `[name]` → '', `[name:value]` → 'value', absent → undefined. */
function control(prompt: string, name: string): string | undefined {
  const m = new RegExp(`\\[${name}(?::([^\\]]*))?\\]`).exec(prompt);
  return m ? (m[1] ?? '') : undefined;
}

function flagValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function chunksOf(text: string, n: number): string[] {
  const words = text.split(/(?<= )/);
  const size = Math.ceil(words.length / Math.max(1, n));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(''));
  return out;
}

async function main(): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V') {
    trace();
    process.stdout.write(kind === 'claude' ? '9.9.9 (Fake Claude Code)\n' : 'codex-cli 9.9.9\n');
    return 0;
  }
  if (kind === 'claude' && argv[0] === 'auth' && argv[1] === 'status') {
    trace();
    out({ loggedIn: !loggedOut, authMethod: loggedOut ? 'none' : 'fake' });
    return loggedOut ? 1 : 0;
  }
  if (kind === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
    trace();
    process.stdout.write(loggedOut ? 'Not logged in\n' : 'Logged in using Fake\n');
    return loggedOut ? 1 : 0;
  }
  if (kind === 'codex' && argv[0] === 'sandbox') {
    trace();
    if (process.env.FAKE_HARNESS_SANDBOX_BROKEN === '1') {
      process.stderr.write('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n');
      return 1;
    }
    return 0;
  }

  const prompt = await readStdin();
  trace({ stdin: prompt });
  const resume =
    kind === 'claude' ? flagValue('--resume') : argv[1] === 'resume' ? argv.at(-2) : undefined;
  const stderr = control(prompt, 'stderr');
  if (stderr) process.stderr.write(`${stderr}\n`);

  if (resume === 'missing-session') {
    if (kind === 'claude') {
      process.stderr.write(`No conversation found with session ID: ${resume}\n`);
      out({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: resume,
        errors: [`No conversation found with session ID: ${resume}`],
      });
    } else {
      process.stderr.write(
        `Error: thread/resume: thread/resume failed: no rollout found for thread id ${resume} (code -32600)\n`,
      );
    }
    return 1;
  }

  const session = resume ?? randomUUID();
  const notLoggedIn = loggedOut || control(prompt, 'not-logged-in') !== undefined;
  const chunks = Number(control(prompt, 'chunks') ?? 3);
  const interval = Number(control(prompt, 'interval') ?? 0);
  const lastLine = prompt.trim().split('\n').at(-1) ?? '';
  const reply = `${resume ? `(resumed ${resume}) ` : ''}Echo: ${lastLine.replace(/\[[^\]]*\]/g, '').trim()}`;

  if (control(prompt, 'grandchild') !== undefined) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    trace({ grandchild: child.pid });
  }

  return kind === 'claude'
    ? claudeTurn({ prompt, session, notLoggedIn, chunks, interval, reply })
    : codexTurn({ prompt, session, notLoggedIn, chunks, interval, reply });
}

interface Turn {
  prompt: string;
  session: string;
  notLoggedIn: boolean;
  chunks: number;
  interval: number;
  reply: string;
}

async function hangOrExit(t: Turn): Promise<number | undefined> {
  const exit = control(t.prompt, 'exit');
  if (exit !== undefined) return Number(exit);
  if (control(t.prompt, 'hang') !== undefined) {
    await new Promise(() => {}); // until killed
  }
  return undefined;
}

async function claudeTurn(t: Turn): Promise<number> {
  const base = { session_id: t.session, parent_tool_use_id: null };
  out({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: t.session,
    tools: [],
    mcp_servers: [],
    model: flagValue('--model') ?? 'fake-model',
    permissionMode: flagValue('--permission-mode') ?? 'default',
  });
  if (t.notLoggedIn) {
    const text = 'Not logged in · Please run /login';
    out({
      type: 'assistant',
      ...base,
      message: { id: 'msg_err', role: 'assistant', content: [{ type: 'text', text }] },
      error: 'authentication_failed',
    });
    out({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: text,
      session_id: t.session,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return 1;
  }
  const early = await hangOrExit(t);
  if (early !== undefined) return early;

  if (control(t.prompt, 'tool') !== undefined) {
    const id = 'toolu_fake_1';
    out({
      type: 'assistant',
      ...base,
      message: {
        id: 'msg_tool',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'note.txt' } }],
      },
    });
    out({
      type: 'user',
      ...base,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'the word is plum' }],
      },
    });
  }
  const msgId = `msg_${randomUUID()}`;
  out({
    type: 'stream_event',
    ...base,
    event: { type: 'message_start', message: { id: msgId, role: 'assistant', content: [] } },
  });
  out({
    type: 'stream_event',
    ...base,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  for (const [i, text] of chunksOf(t.reply, t.chunks).entries()) {
    if (i > 0 && t.interval) await sleep(t.interval);
    out({
      type: 'stream_event',
      ...base,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
  }
  out({
    type: 'assistant',
    ...base,
    message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: t.reply }] },
  });
  out({ type: 'stream_event', ...base, event: { type: 'content_block_stop', index: 0 } });
  out({
    type: 'stream_event',
    ...base,
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 7 },
    },
  });
  out({ type: 'stream_event', ...base, event: { type: 'message_stop' } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    session_id: t.session,
    result: t.reply,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    },
  });
  return 0;
}

async function codexTurn(t: Turn): Promise<number> {
  out({ type: 'thread.started', thread_id: t.session });
  out({ type: 'turn.started' });
  if (t.notLoggedIn) {
    const message =
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
    out({ type: 'error', message: `Reconnecting... 1/5 (${message})` });
    out({ type: 'turn.failed', error: { message } });
    return 1;
  }
  const early = await hangOrExit(t);
  if (early !== undefined) return early;

  let item = 0;
  if (control(t.prompt, 'tool') !== undefined) {
    const cmd = {
      id: `item_${item++}`,
      type: 'command_execution',
      command: "/bin/bash -lc 'cat note.txt'",
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    };
    out({ type: 'item.started', item: cmd });
    out({
      type: 'item.completed',
      item: { ...cmd, aggregated_output: 'the word is plum\n', exit_code: 0, status: 'completed' },
    });
  }
  for (const [i, text] of chunksOf(t.reply, t.chunks).entries()) {
    if (i > 0 && t.interval) await sleep(t.interval);
    out({
      type: 'item.completed',
      item: { id: `item_${item++}`, type: 'agent_message', text: text.trim() },
    });
  }
  out({
    type: 'turn.completed',
    usage: {
      input_tokens: 20,
      cached_input_tokens: 8,
      cache_write_input_tokens: 0,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    },
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`fake harness crashed: ${String(err)}\n`);
    process.exit(70);
  },
);
