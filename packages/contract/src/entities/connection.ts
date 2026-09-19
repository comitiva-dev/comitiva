import { z } from 'zod';
import { Id, IsoDate } from '../common.js';
import {
  AnthropicConfig,
  CliConfig,
  CodexConfig,
  GoogleConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from '../provider-config.js';

const base = {
  id: Id,
  name: z.string().min(1),
  secretRef: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
};

/** A way to reach an LLM. `config` is typed by `provider`. */
export const Connection = z.discriminatedUnion('provider', [
  z.object({
    ...base,
    kind: z.literal('api'),
    provider: z.literal('anthropic'),
    config: AnthropicConfig,
  }),
  z.object({
    ...base,
    kind: z.literal('api'),
    provider: z.literal('openai-compatible'),
    config: OpenAICompatibleConfig,
  }),
  z.object({
    ...base,
    kind: z.literal('api'),
    provider: z.literal('google'),
    config: GoogleConfig,
  }),
  z.object({
    ...base,
    kind: z.literal('api'),
    provider: z.literal('ollama'),
    config: OllamaConfig,
  }),
  z.object({
    ...base,
    kind: z.literal('cli'),
    provider: z.literal('claude-code'),
    config: CliConfig,
  }),
  z.object({ ...base, kind: z.literal('cli'), provider: z.literal('codex'), config: CodexConfig }),
  z.object({
    ...base,
    kind: z.literal('cli'),
    provider: z.literal('gemini-cli'),
    config: CliConfig,
  }),
]);
export type Connection = z.infer<typeof Connection>;
