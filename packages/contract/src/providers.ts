import type { OpenAICompatiblePreset, ProviderId } from './provider-config.js';

/**
 * Static description of each API provider: what the runner adapter supports
 * and what the connection form needs. Plain data (no zod) so any shell can
 * build forms without asking the runner. Adapters take `capabilities` from
 * here. CLI harnesses are described in `cliProviderDescriptors` below.
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
  /** Cheap model for auto-titles on this endpoint; overrides the provider's. */
  titleModel?: string;
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
  /**
   * Cheap model used to title conversations. Absent: titles use the agent's
   * model when it costs nothing (`'agent'`, local providers) or stay a
   * truncation of the first message.
   */
  titleModel?: string;
}

const api: Capabilities = {
  streaming: true,
  tools: true,
  resume: false,
  listModels: true,
  usage: true,
  images: true,
};

export const providerDescriptors = {
  anthropic: {
    id: 'anthropic',
    kind: 'api',
    label: 'Anthropic',
    capabilities: api,
    secret: 'required',
    baseUrl: { mode: 'advanced', default: 'https://api.anthropic.com' },
    titleModel: 'claude-haiku-4-5',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    kind: 'api',
    label: 'OpenAI-compatible',
    capabilities: api,
    secret: 'optional',
    baseUrl: { mode: 'required', default: 'https://api.openai.com/v1' },
    presets: [
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        secret: 'required',
        titleModel: 'gpt-5-mini',
      },
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
      {
        id: 'lmstudio',
        label: 'LM Studio',
        baseUrl: 'http://localhost:1234/v1',
        secret: 'none',
        titleModel: 'agent',
      },
      { id: 'custom', label: 'Custom', baseUrl: '', secret: 'optional' },
    ],
  },
  google: {
    id: 'google',
    kind: 'api',
    label: 'Google Gemini',
    capabilities: api,
    secret: 'required',
    baseUrl: { mode: 'advanced', default: 'https://generativelanguage.googleapis.com' },
    titleModel: 'gemini-2.5-flash-lite',
  },
  ollama: {
    id: 'ollama',
    kind: 'api',
    label: 'Ollama',
    capabilities: api,
    secret: 'optional',
    baseUrl: { mode: 'required', default: 'http://localhost:11434' },
    // Local models cost nothing: titles use the agent's own model.
    titleModel: 'agent',
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

/**
 * The model to title a conversation with: a cheap one for the provider or
 * preset, `null` to keep the truncated first message. `'agent'` in a
 * descriptor means the agent's own model (local providers).
 */
export function titleModelFor(
  provider: ApiProviderId,
  preset: OpenAICompatiblePreset | undefined,
  agentModel: string,
): string | null {
  const d: ProviderDescriptor = providerDescriptors[provider];
  const model = d.presets ? d.presets.find((p) => p.id === preset)?.titleModel : d.titleModel;
  if (model === 'agent') return agentModel || null;
  return model ?? null;
}

// ------------------------------------------------------------ CLI harnesses

/** Static description of a CLI harness (Claude Code, Codex): what the form explains. */
export interface CliProviderDescriptor {
  id: ProviderId;
  kind: 'cli';
  label: string;
  capabilities: Capabilities;
  /** Executable name searched on PATH when the connection has no binary path. */
  binaryName: string;
  /** What the user runs in a terminal when the harness is not logged in. */
  loginCommand: string;
  /**
   * `token`: text streams token by token. `message`: each assistant message
   * arrives whole (Codex `exec --json` has no token deltas).
   */
  streaming: 'token' | 'message';
  /**
   * Whether the harness's own file tools can be turned off so writes go through
   * Comitiva's approvals. `phase-5`: yes, once the filesystem server exists;
   * `never`: not possible (the form warns).
   */
  nativeFileToolsDisableable: 'phase-5' | 'never';
  /** Codex only: the harness has its own OS sandbox, chosen per connection. */
  sandbox?: boolean;
}

// Harnesses reach the agent's tools through the runner's MCP proxy (ADR 0009).
// Images are not passed to them: attachments fall back to a text note.
const harness: Capabilities = {
  streaming: true,
  tools: true,
  resume: true,
  listModels: false,
  usage: true,
  images: false,
};

export const cliProviderDescriptors = {
  'claude-code': {
    id: 'claude-code',
    kind: 'cli',
    label: 'Claude Code',
    capabilities: harness,
    binaryName: 'claude',
    loginCommand: 'claude auth login',
    streaming: 'token',
    nativeFileToolsDisableable: 'phase-5',
  },
  codex: {
    id: 'codex',
    kind: 'cli',
    label: 'Codex',
    capabilities: harness,
    binaryName: 'codex',
    loginCommand: 'codex login',
    streaming: 'message',
    nativeFileToolsDisableable: 'never',
    sandbox: true,
  },
} as const satisfies Record<string, CliProviderDescriptor>;

export type CliProviderId = keyof typeof cliProviderDescriptors;
export const cliProviderIds = Object.keys(cliProviderDescriptors) as CliProviderId[];

export const isApiProviderId = (p: string): p is ApiProviderId =>
  (apiProviderIds as readonly string[]).includes(p);
export const isCliProviderId = (p: string): p is CliProviderId =>
  (cliProviderIds as readonly string[]).includes(p);

/** The connection kind a provider implies (`gemini-cli` is a harness without an adapter yet). */
export function providerKind(provider: ProviderId): 'api' | 'cli' {
  return isApiProviderId(provider) ? 'api' : 'cli';
}
