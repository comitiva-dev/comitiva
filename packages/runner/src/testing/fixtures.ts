import { join } from 'node:path';
import type { Agent, CliConfig, CodexConfig, Connection, Message } from '@comitiva/contract';

const now = '2026-01-01T00:00:00.000Z';

export function anthropicConnection(
  baseUrl?: string,
): Extract<Connection, { provider: 'anthropic' }> {
  return {
    id: 'conn-anthropic',
    name: 'Anthropic',
    kind: 'api',
    provider: 'anthropic',
    config: { defaultModel: 'claude-haiku-4-5', ...(baseUrl ? { baseUrl } : {}) },
    secretRef: 'connection:conn-anthropic',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function openaiConnection(
  baseUrl: string,
): Extract<Connection, { provider: 'openai-compatible' }> {
  return {
    id: 'conn-openai',
    name: 'OpenAI-compatible',
    kind: 'api',
    provider: 'openai-compatible',
    config: { baseUrl, preset: 'custom', defaultModel: 'gpt-fake-mini' },
    secretRef: 'connection:conn-openai',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function googleConnection(baseUrl?: string): Extract<Connection, { provider: 'google' }> {
  return {
    id: 'conn-google',
    name: 'Gemini',
    kind: 'api',
    provider: 'google',
    config: { defaultModel: 'gemini-fake-flash', ...(baseUrl ? { baseUrl } : {}) },
    secretRef: 'connection:conn-google',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function ollamaConnection(baseUrl: string): Extract<Connection, { provider: 'ollama' }> {
  return {
    id: 'conn-ollama',
    name: 'Ollama',
    kind: 'api',
    provider: 'ollama',
    config: { baseUrl, defaultModel: 'llama-fake:latest' },
    secretRef: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** One connection per API provider, all pointing at a fake server's URLs. */
export function fakeConnections(urls: {
  anthropic: string;
  openai: string;
  google: string;
  ollama: string;
}): Connection[] {
  return [
    anthropicConnection(urls.anthropic),
    openaiConnection(urls.openai),
    googleConnection(urls.google),
    ollamaConnection(urls.ollama),
  ];
}

export function testAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Tester',
    avatar: { color: 'indigo', emoji: '🧪' },
    connectionId: 'conn-anthropic',
    model: 'claude-haiku-4-5',
    role: '',
    params: {},
    toolServerIds: [],
    roots: [],
    permissionPolicy: 'ask',
    fallbackConnectionIds: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function userText(conversationId: string, text: string, seq = 0): Message {
  return {
    id: `msg-${conversationId}-${seq}`,
    conversationId,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'complete',
    error: null,
    seq,
    createdAt: now,
  };
}

/**
 * Paths of the fake harness binaries (`dist/testing/bin`), given the runner
 * package directory, e.g. `dirname(require.resolve('@comitiva/runner/package.json'))`.
 * (No `import.meta` here: Playwright loads this module as CommonJS.)
 */
export function fakeHarnessBinaries(runnerPackageDir: string): { claude: string; codex: string } {
  return {
    claude: join(runnerPackageDir, 'dist', 'testing', 'bin', 'fake-claude'),
    codex: join(runnerPackageDir, 'dist', 'testing', 'bin', 'fake-codex'),
  };
}

export function claudeCodeConnection(
  binaryPath?: string,
  config: Partial<CliConfig> = {},
): Extract<Connection, { provider: 'claude-code' }> {
  return {
    id: 'conn-claude-code',
    name: 'Claude Code',
    kind: 'cli',
    provider: 'claude-code',
    config: { extraArgs: [], ...(binaryPath ? { binaryPath } : {}), ...config },
    secretRef: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function codexConnection(
  binaryPath?: string,
  config: Partial<CodexConfig> = {},
): Extract<Connection, { provider: 'codex' }> {
  return {
    id: 'conn-codex',
    name: 'Codex',
    kind: 'cli',
    provider: 'codex',
    config: {
      extraArgs: [],
      sandbox: 'workspace-write',
      ...(binaryPath ? { binaryPath } : {}),
      ...config,
    },
    secretRef: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
