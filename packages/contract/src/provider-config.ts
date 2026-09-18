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

export const CliConfig = z.object({
  binaryPath: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
});
export type CliConfig = z.infer<typeof CliConfig>;
