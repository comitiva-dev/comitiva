import { z } from 'zod';

export const ProviderId = z.enum([
  'anthropic',
  'openai-compatible',
  'google',
  'ollama',
  'claude-code',
  'codex',
  'gemini-cli',
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ConnectionKind = z.enum(['api', 'cli']);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const AnthropicConfig = z.object({
  baseUrl: z.url().optional(),
  defaultModel: z.string().optional(),
});
export type AnthropicConfig = z.infer<typeof AnthropicConfig>;

/** UI hint for OpenAI-compatible connections: picks the icon and the default base URL. */
export const OpenAICompatiblePreset = z.enum([
  'openai',
  'openrouter',
  'groq',
  'lmstudio',
  'custom',
]);
export type OpenAICompatiblePreset = z.infer<typeof OpenAICompatiblePreset>;

export const OpenAICompatibleConfig = z.object({
  baseUrl: z.url(),
  preset: OpenAICompatiblePreset.optional(),
  defaultModel: z.string().optional(),
});
export type OpenAICompatibleConfig = z.infer<typeof OpenAICompatibleConfig>;

export const GoogleConfig = z.object({
  /** Override for proxies, gateways and tests; defaults to Google's endpoint. */
  baseUrl: z.url().optional(),
  defaultModel: z.string().optional(),
});
export type GoogleConfig = z.infer<typeof GoogleConfig>;

export const OllamaConfig = z.object({
  baseUrl: z.url().default('http://localhost:11434'),
  defaultModel: z.string().optional(),
});
export type OllamaConfig = z.infer<typeof OllamaConfig>;

/** Settings shared by every CLI harness connection. */
export const CliConfig = z.object({
  /** Absolute path to the binary; unset → found on PATH and the usual install dirs. */
  binaryPath: z.string().optional(),
  /** Appended after Comitiva's own flags, so they can override them. One argv entry each. */
  extraArgs: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
  /** Absolute path; unset → `<userData>/workspaces/<conversationId>`. */
  workingDirectory: z.string().optional(),
});
export type CliConfig = z.infer<typeof CliConfig>;

/** Codex's own sandbox for the commands and file edits it runs (`-c sandbox_mode`). */
export const CodexSandbox = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type CodexSandbox = z.infer<typeof CodexSandbox>;

export const CodexConfig = CliConfig.extend({
  sandbox: CodexSandbox.default('workspace-write'),
});
export type CodexConfig = z.infer<typeof CodexConfig>;
