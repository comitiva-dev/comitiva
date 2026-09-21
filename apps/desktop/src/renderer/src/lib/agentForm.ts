import {
  AvatarColor,
  isCliProviderId,
  providerDescriptors,
  type Agent,
  type AgentDraft,
  type AgentParams,
  type AgentPatch,
  type Connection,
  type ConnectionSummary,
} from '@comitiva/contract';
import { isApiProvider } from './connectionForm';

/**
 * Pure logic behind AgentForm: form state ⇄ drafts and patches, validation,
 * connection groups and tags. Kept out of the component so it is unit-tested
 * without a DOM.
 */

export const avatarColors = AvatarColor.options;

/** A curated set; any emoji can also be typed. */
export const avatarEmojis = [
  '🤖',
  '🧠',
  '🔎',
  '✍️',
  '📝',
  '📚',
  '🧐',
  '🗂️',
  '📊',
  '💡',
  '🎯',
  '🧭',
  '🦉',
  '🦊',
  '🐙',
  '🐝',
  '🌱',
  '🚀',
  '🎨',
  '📣',
  '🧮',
  '⚖️',
  '🛠️',
  '💬',
] as const;

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;

export interface AgentFormState {
  name: string;
  color: AvatarColor;
  /** '' shows the name's initials. */
  emoji: string;
  connectionId: string;
  /** '' uses the connection's default model (or the harness's). */
  model: string;
  role: string;
  /** Text fields; '' leaves the provider's default. */
  temperature: string;
  maxTokens: string;
  tags: string[];
}

export type AgentFormProblem = 'name' | 'connection' | 'model' | 'temperature' | 'maxTokens';

/** A new form on the first enabled connection, with any prefilled fields on top. */
export function newAgentForm(
  connections: ConnectionSummary[],
  prefill: Partial<AgentFormState> = {},
): AgentFormState {
  const first = connections.find((c) => c.connection.enabled);
  return {
    name: '',
    color: 'indigo',
    emoji: '',
    connectionId: first?.connection.id ?? '',
    model: '',
    role: '',
    temperature: '',
    maxTokens: '',
    tags: [],
    ...prefill,
  };
}

export function agentFormFor(agent: Agent): AgentFormState {
  return {
    name: agent.name,
    color: agent.avatar.color,
    emoji: agent.avatar.emoji ?? '',
    connectionId: agent.connectionId,
    model: agent.model ?? '',
    role: agent.role,
    temperature: agent.params.temperature?.toString() ?? '',
    maxTokens: agent.params.maxTokens?.toString() ?? '',
    tags: [...agent.tags],
  };
}

const findConnection = (connections: ConnectionSummary[], id: string): Connection | undefined =>
  connections.find((c) => c.connection.id === id)?.connection;

export const defaultModelOf = (connection: Connection | undefined): string | undefined =>
  (connection?.config as { defaultModel?: string } | undefined)?.defaultModel || undefined;

/** API connections can list models when their provider supports it; harnesses take free text. */
export function supportsModelList(connection: Connection | undefined): boolean {
  if (!connection || !isApiProvider(connection.provider)) return false;
  return providerDescriptors[connection.provider].capabilities.listModels;
}

/** Temperature and max tokens reach API providers; CLI harnesses use their own settings. */
export const paramsApply = (connection: Connection | undefined): boolean =>
  connection?.kind !== 'cli';

export type ConnectionState = 'ok' | 'disabled' | 'missing';

export function connectionState(connection: Connection | undefined): ConnectionState {
  if (!connection) return 'missing';
  return connection.enabled ? 'ok' : 'disabled';
}

/**
 * Connections the form offers, grouped by kind: the enabled ones, plus the
 * agent's current connection even if it was disabled since.
 */
export function connectionGroups(
  connections: ConnectionSummary[],
  currentId: string | null,
): { api: Connection[]; cli: Connection[] } {
  const offered = connections
    .map((c) => c.connection)
    .filter((c) => c.enabled || c.id === currentId)
    .filter((c) => isApiProvider(c.provider) || isCliProviderId(c.provider));
  return {
    api: offered.filter((c) => c.kind === 'api'),
    cli: offered.filter((c) => c.kind === 'cli'),
  };
}

const parseNumber = (text: string): number | undefined =>
  text.trim() === '' ? undefined : Number(text.trim());

export function problems(
  form: AgentFormState,
  connections: ConnectionSummary[],
): AgentFormProblem[] {
  const out: AgentFormProblem[] = [];
  const connection = findConnection(connections, form.connectionId);
  if (form.name.trim() === '') out.push('name');
  if (!connection) out.push('connection');
  if (connection?.kind === 'api' && form.model.trim() === '' && !defaultModelOf(connection)) {
    out.push('model');
  }
  if (paramsApply(connection)) {
    const temperature = parseNumber(form.temperature);
    if (temperature !== undefined && !(temperature >= 0 && temperature <= 2)) {
      out.push('temperature');
    }
    const maxTokens = parseNumber(form.maxTokens);
    if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens > 0)) {
      out.push('maxTokens');
    }
  }
  return out;
}

/** Params from the form, keeping any the form does not show (e.g. topP). */
function paramsFrom(form: AgentFormState, base: AgentParams): AgentParams {
  const { temperature: _t, maxTokens: _m, ...rest } = base;
  const temperature = parseNumber(form.temperature);
  const maxTokens = parseNumber(form.maxTokens);
  return {
    ...rest,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function avatarFrom(form: AgentFormState): AgentDraft['avatar'] {
  const emoji = form.emoji.trim();
  return emoji ? { color: form.color, emoji } : { color: form.color };
}

export function toAgentDraft(form: AgentFormState): AgentDraft {
  return {
    name: form.name.trim(),
    avatar: avatarFrom(form),
    connectionId: form.connectionId,
    model: form.model.trim() || null,
    role: form.role,
    params: paramsFrom(form, {}),
    tags: form.tags,
  };
}

/** The whole editable state as a patch; roots and tools (Phase 5) are left alone. */
export function toAgentPatch(form: AgentFormState, agent: Agent): AgentPatch {
  return {
    name: form.name.trim(),
    avatar: avatarFrom(form),
    connectionId: form.connectionId,
    model: form.model.trim() || null,
    role: form.role,
    params: paramsFrom(form, agent.params),
    tags: form.tags,
  };
}

/**
 * Adds tags typed as text ("a, b"): trimmed, capped in length and count,
 * without repeating one that is already there in another case.
 */
export function addTags(tags: string[], input: string): string[] {
  const out = [...tags];
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || out.length >= MAX_TAGS) continue;
    if (out.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    out.push(tag);
  }
  return out;
}

/** Up to two letters from the name's first words, for avatars without an emoji. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase());
  return letters.join('') || '?';
}
