import type {
  ToolDef,
  ToolServer,
  ToolServerDraft,
  ToolServerPatch,
  ToolServerSpec,
  ToolServerValueInput,
} from '@comitiva/contract';

/**
 * An env var (stdio) or a header (http). A secret row with a stored value and
 * an empty field keeps the stored secret; typing replaces it. Stored secrets
 * are never sent back to the form.
 */
export interface ValueRow {
  key: string;
  value: string;
  secret: boolean;
  /** A secret is already stored for this name. */
  stored: boolean;
}

export interface ToolServerForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  /** One argument per line. */
  args: string;
  env: ValueRow[];
  url: string;
  headers: ValueRow[];
  enabled: boolean;
}

export type ToolServerFormProblem =
  | 'nameRequired'
  | 'commandRequired'
  | 'urlInvalid'
  | 'keyInvalid'
  | 'keyRepeated'
  | 'secretRequired';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const emptyRow = (): ValueRow => ({ key: '', value: '', secret: false, stored: false });

export function emptyForm(): ToolServerForm {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: [],
    url: '',
    headers: [],
    enabled: true,
  };
}

export function formFromServer(server: ToolServer): ToolServerForm {
  const rows = (values: ToolServer['env']): ValueRow[] =>
    Object.entries(values).map(([key, v]) =>
      'value' in v
        ? { key, value: v.value, secret: false, stored: false }
        : { key, value: '', secret: true, stored: true },
    );
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args.join('\n'),
    env: rows(server.env),
    url: server.url ?? '',
    headers: rows(server.headers),
    enabled: server.enabled,
  };
}

/** Rows with a blank name and value are ignored. */
const filled = (rows: ValueRow[]) => rows.filter((r) => r.key.trim() !== '' || r.value !== '');

export function formProblems(form: ToolServerForm): ToolServerFormProblem[] {
  const problems = new Set<ToolServerFormProblem>();
  if (form.name.trim() === '') problems.add('nameRequired');
  if (form.transport === 'stdio' && form.command.trim() === '') problems.add('commandRequired');
  if (form.transport === 'http' && !isHttpUrl(form.url.trim())) problems.add('urlInvalid');
  const rows = filled(form.transport === 'stdio' ? form.env : form.headers);
  const pattern = form.transport === 'stdio' ? ENV_NAME : HEADER_NAME;
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.key.trim();
    if (!pattern.test(key)) problems.add('keyInvalid');
    if (seen.has(key)) problems.add('keyRepeated');
    seen.add(key);
    if (r.secret && r.value === '' && !r.stored) problems.add('secretRequired');
  }
  return [...problems];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function values(rows: ValueRow[]): Record<string, ToolServerValueInput> {
  return Object.fromEntries(
    filled(rows).map((r): [string, ToolServerValueInput] => [
      r.key.trim(),
      !r.secret
        ? { value: r.value }
        : r.value === '' && r.stored
          ? { keepSecret: true }
          : { secret: r.value },
    ]),
  );
}

export function formToSpec(form: ToolServerForm): ToolServerSpec {
  if (form.transport === 'http') {
    return { transport: 'http', url: form.url.trim(), headers: values(form.headers) };
  }
  return {
    transport: 'stdio',
    command: form.command.trim(),
    args: form.args
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a !== ''),
    env: values(form.env),
  };
}

export function formToDraft(form: ToolServerForm): ToolServerDraft {
  return { name: form.name.trim(), enabled: form.enabled, spec: formToSpec(form) };
}

export function formToPatch(form: ToolServerForm): ToolServerPatch {
  return { name: form.name.trim(), spec: formToSpec(form) };
}

/** What the list shows for a server's address: the command line or the URL. */
export function describeServer(server: ToolServer): string {
  if (server.transport === 'http') return server.url ?? '';
  return [server.command ?? '', ...server.args].join(' ').trim();
}

/** A server's name as the UI shows it: built-ins are translated. */
export function serverDisplayName(server: ToolServer, t: (key: string) => string): string {
  return server.builtin ? t(`tools.builtin.${server.id}.name`) : server.name;
}

export type ToolBadge = 'readOnly' | 'asks' | 'destructive' | 'noAnnotations';

/**
 * How the Tools screen labels a tool, from its MCP annotations: read-only
 * tools run freely; anything else asks first under the `ask` policy.
 * `destructiveHint` defaults to true for tools that are not read-only (MCP),
 * so it is flagged unless the server says false. A tool without annotations
 * is flagged as such instead.
 */
export function toolBadges(tool: ToolDef): ToolBadge[] {
  const a = tool.annotations;
  if (a?.readOnlyHint === true) return ['readOnly'];
  if (!a || (a.readOnlyHint === undefined && a.destructiveHint === undefined)) {
    return ['asks', 'noAnnotations'];
  }
  return a.destructiveHint === false ? ['asks'] : ['asks', 'destructive'];
}
