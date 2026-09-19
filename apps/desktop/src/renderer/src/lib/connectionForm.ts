import {
  ConnectionDraft,
  apiProviderIds,
  cliProviderDescriptors,
  isCliProviderId,
  providerDescriptors,
  secretRequirement,
  type ApiProviderId,
  type ConnectionPatch,
  type ConnectionProbe,
  type ConnectionSummary,
  type ConnectionTarget,
  type OpenAICompatiblePreset,
  type ProviderId,
  type SecretRequirement,
} from '@comitiva/contract';

/**
 * Pure logic behind ConnectionForm: form state ⇄ drafts, patches and probes.
 * Kept out of the component so it is unit-tested without a DOM.
 */

export interface FormState {
  provider: ApiProviderId;
  preset: OpenAICompatiblePreset;
  name: string;
  /** True once the user typed a name; until then it follows the provider. */
  nameTouched: boolean;
  /** Typed key; never prefilled (the stored key never reaches the renderer). */
  apiKey: string;
  /** Edit only: remove the stored key on save. */
  removeKey: boolean;
  baseUrl: string;
  defaultModel: string;
}

export type FormProblem = 'name' | 'baseUrl' | 'apiKey';

export const isApiProvider = (p: string): p is ApiProviderId =>
  (apiProviderIds as readonly string[]).includes(p);

export function providerLabel(provider: ProviderId, preset?: OpenAICompatiblePreset): string {
  if (isCliProviderId(provider)) return cliProviderDescriptors[provider].label;
  if (!isApiProvider(provider)) return provider;
  const d = providerDescriptors[provider];
  const presets = 'presets' in d ? d.presets : undefined;
  const p = presets?.find((x) => x.id === preset);
  return p && p.id !== 'custom' ? p.label : d.label;
}

function defaultBaseUrl(provider: ApiProviderId, preset: OpenAICompatiblePreset): string {
  if (provider === 'openai-compatible') {
    return providerDescriptors[provider].presets.find((p) => p.id === preset)?.baseUrl ?? '';
  }
  const d = providerDescriptors[provider];
  // Advanced overrides start empty: the provider default applies.
  return d.baseUrl.mode === 'required' ? d.baseUrl.default : '';
}

export function newForm(provider: ApiProviderId = 'anthropic'): FormState {
  const preset: OpenAICompatiblePreset = 'openai';
  return {
    provider,
    preset,
    name: providerLabel(provider, preset),
    nameTouched: false,
    apiKey: '',
    removeKey: false,
    baseUrl: defaultBaseUrl(provider, preset),
    defaultModel: '',
  };
}

export function formFor(summary: ConnectionSummary): FormState {
  const { connection } = summary;
  if (!isApiProvider(connection.provider)) throw new Error('Only API connections are editable');
  const config = connection.config as {
    baseUrl?: string;
    preset?: OpenAICompatiblePreset;
    defaultModel?: string;
  };
  return {
    provider: connection.provider,
    preset: config.preset ?? 'custom',
    name: connection.name,
    nameTouched: true,
    apiKey: '',
    removeKey: false,
    baseUrl: config.baseUrl ?? '',
    defaultModel: config.defaultModel ?? '',
  };
}

/** Switching provider or preset resets the endpoint; the name follows until touched. */
export function withProvider(
  form: FormState,
  provider: ApiProviderId,
  preset: OpenAICompatiblePreset = form.preset,
): FormState {
  return {
    ...form,
    provider,
    preset,
    baseUrl: defaultBaseUrl(provider, preset),
    defaultModel: provider === form.provider && preset === form.preset ? form.defaultModel : '',
    name: form.nameTouched ? form.name : providerLabel(provider, preset),
  };
}

export function keyRequirement(form: FormState): SecretRequirement {
  return secretRequirement(
    form.provider,
    form.provider === 'openai-compatible' ? form.preset : undefined,
  );
}

export function baseUrlMode(form: FormState): 'required' | 'advanced' {
  return providerDescriptors[form.provider].baseUrl.mode;
}

function config(form: FormState): Record<string, unknown> {
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  return {
    ...(baseUrl !== '' ? { baseUrl } : {}),
    ...(form.provider === 'openai-compatible' ? { preset: form.preset } : {}),
    ...(defaultModel !== '' ? { defaultModel } : {}),
  };
}

const typedKey = (form: FormState) => {
  const key = form.apiKey.trim();
  return key === '' ? undefined : key;
};

/** Problems that block saving. `hasStoredKey` is true when editing a connection that has one. */
export function problems(form: FormState, hasStoredKey: boolean): FormProblem[] {
  const out: FormProblem[] = [];
  if (form.name.trim() === '') out.push('name');
  const draft = ConnectionDraft.safeParse({
    name: 'x',
    provider: form.provider,
    config: config(form),
  });
  if (!draft.success) out.push('baseUrl');
  const keyAvailable = typedKey(form) !== undefined || (hasStoredKey && !form.removeKey);
  if (keyRequirement(form) === 'required' && !keyAvailable) out.push('apiKey');
  return out;
}

export function toDraft(form: FormState): ConnectionDraft {
  const key = keyRequirement(form) === 'none' ? undefined : typedKey(form);
  return ConnectionDraft.parse({
    name: form.name.trim(),
    provider: form.provider,
    config: config(form),
    enabled: true,
    ...(key ? { apiKey: key } : {}),
  });
}

export function toPatch(form: FormState, hasStoredKey: boolean): ConnectionPatch {
  const key = keyRequirement(form) === 'none' ? undefined : typedKey(form);
  const dropKey = hasStoredKey && (form.removeKey || keyRequirement(form) === 'none');
  return {
    name: form.name.trim(),
    config: config(form),
    ...(key ? { apiKey: key } : dropKey ? { apiKey: null } : {}),
  };
}

/**
 * Target for testing or listing models with what is on screen. When editing
 * and no new key is typed, main reuses the stored key (unless it is being removed).
 */
export function toTarget(form: FormState, editingId: string | null): ConnectionTarget | null {
  const key = typedKey(form);
  const probe = { provider: form.provider, config: config(form), ...(key ? { apiKey: key } : {}) };
  const parsed = ConnectionDraft.safeParse({ ...probe, name: 'probe' });
  if (!parsed.success) return null;
  const reuseStoredKey = editingId !== null && !form.removeKey && key === undefined;
  return {
    probe: probe as ConnectionProbe,
    ...(reuseStoredKey ? { id: editingId } : {}),
  };
}
