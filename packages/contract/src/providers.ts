import type { OpenAICompatiblePreset, ProviderId } from './provider-config.js';

/**
 * Static description of each provider: what the runner adapter supports and
 * what the connection form needs. Plain data (no zod) so any shell can build
 * forms without asking the runner. Adapters take `capabilities` from here.
 */

export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  resume: boolean;
  listModels: boolean;
  usage: boolean;
  images: boolean;
}

/** Whether a connection needs an API key. */
export type SecretRequirement = 'required' | 'optional' | 'none';

export interface ProviderPreset {
  id: OpenAICompatiblePreset;
  label: string;
  baseUrl: string;
  secret: SecretRequirement;
}

export interface ProviderDescriptor {
  id: ProviderId;
  kind: 'api' | 'cli';
  label: string;
  capabilities: Capabilities;
  secret: SecretRequirement;
  /** `required`: always shown and needed; `advanced`: optional override of `default`. */
  baseUrl: { mode: 'required' | 'advanced'; default: string };
  /** Only for openai-compatible: known endpoints that fill the base URL. */
  presets?: ProviderPreset[];
}

const textOnly: Capabilities = {
  streaming: true,
  tools: false,
  resume: false,
  listModels: true,
  usage: true,
  images: false,
};

export const providerDescriptors = {
  anthropic: {
    id: 'anthropic',
    kind: 'api',
    label: 'Anthropic',
    capabilities: { ...textOnly, images: true },
    secret: 'required',
    baseUrl: { mode: 'advanced', default: 'https://api.anthropic.com' },
  },
  'openai-compatible': {
    id: 'openai-compatible',
    kind: 'api',
    label: 'OpenAI-compatible',
    capabilities: textOnly,
    secret: 'optional',
    baseUrl: { mode: 'required', default: 'https://api.openai.com/v1' },
    presets: [
      { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', secret: 'required' },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        secret: 'required',
      },
      {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        secret: 'required',
      },
      { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', secret: 'none' },
      { id: 'custom', label: 'Custom', baseUrl: '', secret: 'optional' },
    ],
  },
  google: {
    id: 'google',
    kind: 'api',
    label: 'Google Gemini',
    capabilities: textOnly,
    secret: 'required',
    baseUrl: { mode: 'advanced', default: 'https://generativelanguage.googleapis.com' },
  },
  ollama: {
    id: 'ollama',
    kind: 'api',
    label: 'Ollama',
    capabilities: textOnly,
    secret: 'optional',
    baseUrl: { mode: 'required', default: 'http://localhost:11434' },
  },
} as const satisfies Record<string, ProviderDescriptor>;

export type ApiProviderId = keyof typeof providerDescriptors;
export const apiProviderIds = Object.keys(providerDescriptors) as ApiProviderId[];

/** The key requirement for a connection, taking the openai-compatible preset into account. */
export function secretRequirement(
  provider: ApiProviderId,
  preset?: OpenAICompatiblePreset,
): SecretRequirement {
  const d: ProviderDescriptor = providerDescriptors[provider];
  return d.presets?.find((p) => p.id === preset)?.secret ?? d.secret;
}
