import {
  ConnectionDraft,
  cliProviderDescriptors,
  isCliProviderId,
  type CliProviderId,
  type CodexSandbox,
  type ConnectionPatch,
  type ConnectionProbe,
  type ConnectionSummary,
  type ConnectionTarget,
} from '@comitiva/contract';

/**
 * Pure logic behind the CLI harness form (Claude Code, Codex): form state ⇄
 * drafts, patches and probes. CLI connections never carry a key.
 */

export interface CliFormState {
  provider: CliProviderId;
  name: string;
  nameTouched: boolean;
  /** Empty → found on PATH and the usual install locations. */
  binaryPath: string;
  /** One argument per line; no shell quoting. */
  extraArgs: string;
  /** Empty → a folder per conversation in Comitiva's data folder. */
  workingDirectory: string;
  defaultModel: string;
  /** Codex only. */
  sandbox: CodexSandbox;
}

export type CliFormProblem = 'name' | 'binaryPath' | 'workingDirectory';

export const codexSandboxes: CodexSandbox[] = [
  'workspace-write',
  'read-only',
  'danger-full-access',
];

export function newCliForm(provider: CliProviderId): CliFormState {
  return {
    provider,
    name: cliProviderDescriptors[provider].label,
    nameTouched: false,
    binaryPath: '',
    extraArgs: '',
    workingDirectory: '',
    defaultModel: '',
    sandbox: 'workspace-write',
  };
}

export function cliFormFor(summary: ConnectionSummary): CliFormState {
  const { connection } = summary;
  if (connection.kind !== 'cli' || !isCliProviderId(connection.provider)) {
    throw new Error('Not a CLI harness connection');
  }
  const config = connection.config as {
    binaryPath?: string;
    extraArgs?: string[];
    workingDirectory?: string;
    defaultModel?: string;
    sandbox?: CodexSandbox;
  };
  return {
    provider: connection.provider,
    name: connection.name,
    nameTouched: true,
    binaryPath: config.binaryPath ?? '',
    extraArgs: (config.extraArgs ?? []).join('\n'),
    workingDirectory: config.workingDirectory ?? '',
    defaultModel: config.defaultModel ?? '',
    sandbox: config.sandbox ?? 'workspace-write',
  };
}

/** Switching harness resets the name (until typed) and keeps the rest. */
export function withCliProvider(form: CliFormState, provider: CliProviderId): CliFormState {
  return {
    ...form,
    provider,
    name: form.nameTouched ? form.name : cliProviderDescriptors[provider].label,
  };
}

/** One argument per non-blank line, trimmed. */
export function parseExtraArgs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Absolute on POSIX (`/x`) or Windows (`C:\x`, `\\server\x`). `~` is not expanded. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

function config(form: CliFormState): Record<string, unknown> {
  const binaryPath = form.binaryPath.trim();
  const workingDirectory = form.workingDirectory.trim();
  const defaultModel = form.defaultModel.trim();
  return {
    extraArgs: parseExtraArgs(form.extraArgs),
    ...(binaryPath !== '' ? { binaryPath } : {}),
    ...(workingDirectory !== '' ? { workingDirectory } : {}),
    ...(defaultModel !== '' ? { defaultModel } : {}),
    ...(form.provider === 'codex' ? { sandbox: form.sandbox } : {}),
  };
}

export function cliProblems(form: CliFormState): CliFormProblem[] {
  const out: CliFormProblem[] = [];
  if (form.name.trim() === '') out.push('name');
  const bin = form.binaryPath.trim();
  if (bin !== '' && !isAbsolutePath(bin)) out.push('binaryPath');
  const wd = form.workingDirectory.trim();
  if (wd !== '' && !isAbsolutePath(wd)) out.push('workingDirectory');
  return out;
}

export function toCliDraft(form: CliFormState): ConnectionDraft {
  return ConnectionDraft.parse({
    name: form.name.trim(),
    provider: form.provider,
    config: config(form),
    enabled: true,
  });
}

export function toCliPatch(form: CliFormState): ConnectionPatch {
  return { name: form.name.trim(), config: config(form) };
}

/** Tests what is on screen; null while the settings are invalid. */
export function toCliTarget(form: CliFormState): ConnectionTarget | null {
  if (cliProblems(form).some((p) => p !== 'name')) return null;
  const probe = { provider: form.provider, config: config(form) };
  return { probe: probe as ConnectionProbe };
}
