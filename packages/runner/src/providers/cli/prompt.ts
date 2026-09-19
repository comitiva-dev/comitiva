import { AppError, type Block, type Message } from '@comitiva/contract';

/**
 * What a harness receives on stdin. With a session to resume, the harness
 * already has the history, so only the new user message goes. Without one
 * (first turn, or a conversation that started elsewhere), earlier messages
 * are replayed as a transcript ahead of the new message.
 */
export function buildPrompt(messages: Message[], resume: boolean): string {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') {
    throw new AppError('invalid_request', 'A CLI turn needs a user message last');
  }
  const current = userText(last);
  const earlier = messages.slice(0, -1);
  if (resume || earlier.length === 0) return current;

  const transcript = earlier
    .map((m) => `<${m.role}>\n${historyText(m.content)}\n</${m.role}>`)
    .join('\n\n');
  return [
    'This conversation started before this session. The transcript so far:',
    '',
    transcript,
    '',
    'Continue the conversation. The new user message:',
    '',
    current,
  ].join('\n');
}

/** The new message: text only (harness connections do not take images yet). */
function userText(m: Message): string {
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      throw new AppError(
        'unsupported_content',
        `${b.type} blocks are not supported by CLI harnesses yet`,
      );
    })
    .join('\n');
}

/** History is best effort: non-text blocks become short markers. */
function historyText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[used tool ${b.name}]`;
        case 'tool_result':
          return `[tool result${b.isError ? ' (error)' : ''}]`;
        case 'image':
          return '[image]';
        case 'document':
          return `[document ${b.name}]`;
      }
    })
    .join('\n');
}

/** Env vars the harness must not see: our own, and ambient provider keys. */
const STRIPPED = [
  'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

/**
 * The harness's env: the runner's, minus Comitiva's variables and provider
 * keys, so it authenticates with its own login (what `auth status` shows).
 */
export function harnessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (STRIPPED.includes(k) || k.startsWith('COMITIVA_')) continue;
    env[k] = v;
  }
  return env;
}
