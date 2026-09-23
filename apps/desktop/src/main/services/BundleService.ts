import { existsSync } from 'node:fs';
import { ulid } from 'ulid';
import {
  AppError,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BuiltinToolServer,
  ImportReport,
  PortableBundle,
  type Agent,
  type ErrorCode,
  type ImportWarning,
  type PortableValue,
  type ToolServer,
  type ValueOrSecret,
} from '@comitiva/contract';
import type { Database } from '../db/Database';
import type { AgentRepository } from '../db/repositories/AgentRepository';
import type { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { ToolServerRepository } from '../db/repositories/ToolServerRepository';

export interface BundleServiceDeps {
  db: Database;
  connections: ConnectionRepository;
  toolServers: ToolServerRepository;
  agents: AgentRepository;
  appVersion: string;
  /** Whether a path exists on this machine (roots, harness binaries). */
  exists?: (path: string) => boolean;
  now?: () => Date;
}

const isBuiltin = (id: string) => BuiltinToolServer.safeParse(id).success;

function portableValues(values: Record<string, ValueOrSecret>): Record<string, PortableValue> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      'value' in v ? { value: v.value } : { secret: true as const },
    ]),
  );
}

/**
 * Export and import of agents with their connections and tool servers, as a
 * portable bundle (ADR 0013). Secrets never go into a bundle: an imported
 * connection has no key and an imported server's secret values point at refs
 * with nothing stored, so a send or a test asks for them (secret_missing).
 */
export class BundleService {
  private readonly exists: (path: string) => boolean;
  private readonly now: () => Date;

  constructor(private readonly deps: BundleServiceDeps) {
    this.exists = deps.exists ?? existsSync;
    this.now = deps.now ?? (() => new Date());
  }

  /** The agents (all when `agentIds` is omitted), and what they use. */
  export(agentIds?: readonly string[]): PortableBundle {
    const all = this.deps.agents.list();
    const agents = agentIds ? all.filter((a) => agentIds.includes(a.id)) : all;
    if (agentIds && agents.length !== agentIds.length) {
      throw new AppError('not_found', 'An agent to export does not exist');
    }
    const connectionIds = [...new Set(agents.map((a) => a.connectionId))];
    const serverIds = [
      ...new Set(agents.flatMap((a) => a.toolServerIds).filter((id) => !isBuiltin(id))),
    ];
    const connectionRef = new Map(connectionIds.map((id, i) => [id, `connection-${i + 1}`]));
    const serverRef = new Map(serverIds.map((id, i) => [id, `tool-server-${i + 1}`]));

    return PortableBundle.parse({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: this.now().toISOString(),
      app: { name: 'Comitiva', version: this.deps.appVersion },
      connections: connectionIds.map((id) => {
        const { connection: c } = this.deps.connections.require(id);
        return {
          ref: connectionRef.get(id)!,
          name: c.name,
          provider: c.provider,
          kind: c.kind,
          enabled: c.enabled,
          config: c.config,
          hadKey: c.secretRef !== null,
        };
      }),
      toolServers: serverIds.map((id) => {
        const s = this.deps.toolServers.require(id);
        return {
          ref: serverRef.get(id)!,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: s.args,
          env: portableValues(s.env),
          url: s.url,
          headers: portableValues(s.headers),
          enabled: s.enabled,
        };
      }),
      agents: agents.map((a: Agent) => ({
        name: a.name,
        avatar: a.avatar,
        connectionRef: connectionRef.get(a.connectionId)!,
        model: a.model,
        role: a.role,
        params: a.params,
        tags: a.tags,
        toolServerRefs: a.toolServerIds.map((id) => (isBuiltin(id) ? id : serverRef.get(id)!)),
        roots: a.roots,
        permissionPolicy: a.permissionPolicy,
      })),
    });
  }

  /**
   * Creates everything in the bundle as new objects, in one transaction.
   * An agent that cannot be created here (its connection needs a model, is
   * disabled…) is skipped with a warning instead of failing the import; an
   * invalid bundle fails it whole.
   */
  import(json: string): ImportReport {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new AppError('invalid_request', 'The file is not JSON');
    }
    const parsed = PortableBundle.safeParse(data);
    if (!parsed.success) {
      const format = (data as { format?: unknown; version?: unknown } | null) ?? {};
      throw new AppError(
        'invalid_request',
        format.format === BUNDLE_FORMAT && format.version !== BUNDLE_VERSION
          ? `This bundle is version ${String(format.version)}; this Comitiva reads version ${BUNDLE_VERSION}`
          : `The file is not a Comitiva bundle: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const bundle = parsed.data;
    const warnings: ImportWarning[] = [];
    const warn = (
      code: ImportWarning['code'],
      subject: string,
      detail: string | null = null,
      error: ErrorCode | null = null,
    ) => warnings.push({ code, subject, detail, error });

    return this.deps.db.transaction(() => {
      const connectionIds = new Map<string, string>();
      for (const c of bundle.connections) {
        const { connection } = this.deps.connections.create({
          name: c.name,
          provider: c.provider,
          config: c.config,
          enabled: c.enabled,
          secretRef: null,
        });
        connectionIds.set(c.ref, connection.id);
        if (c.hadKey) warn('key_needed', c.name);
        const binary = c.config.binaryPath;
        if (typeof binary === 'string' && binary !== '' && !this.exists(binary)) {
          warn('binary_not_found', c.name, binary);
        }
      }

      const serverIds = new Map<string, string>();
      for (const s of bundle.toolServers) {
        const id = ulid();
        const values = (kind: 'env' | 'header', v: Record<string, PortableValue>) =>
          Object.fromEntries(
            Object.entries(v).map(([name, value]): [string, ValueOrSecret] => {
              if ('value' in value) return [name, { value: value.value }];
              warn('secret_needed', s.name, name);
              // Nothing is stored under this ref until the user enters the value.
              return [name, { secretRef: `toolServer:${id}:${kind}:${name}` }];
            }),
          );
        const server: ToolServer = this.deps.toolServers.create({
          id,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: s.args,
          env: values('env', s.env),
          url: s.url,
          headers: values('header', s.headers),
          enabled: s.enabled,
        });
        serverIds.set(s.ref, server.id);
      }

      let created = 0;
      for (const a of bundle.agents) {
        const connectionId = connectionIds.get(a.connectionRef);
        if (!connectionId) {
          throw new AppError('invalid_request', `Agent ${a.name} refers to a missing connection`);
        }
        const toolServerIds = a.toolServerRefs.map((ref) => {
          const id = isBuiltin(ref) ? ref : serverIds.get(ref);
          if (!id)
            throw new AppError(
              'invalid_request',
              `Agent ${a.name} refers to a missing tool server`,
            );
          return id;
        });
        try {
          this.deps.db.transaction(() =>
            this.deps.agents.create({
              name: a.name,
              avatar: a.avatar,
              connectionId,
              model: a.model,
              role: a.role,
              params: a.params,
              tags: a.tags,
              toolServerIds,
              roots: a.roots,
              permissionPolicy: a.permissionPolicy,
            }),
          );
          created += 1;
          for (const root of a.roots) {
            if (!this.exists(root.path)) warn('root_missing', a.name, root.path);
          }
        } catch (err) {
          const code = err instanceof AppError ? err.code : 'internal';
          warn('agent_skipped', a.name, null, code);
        }
      }

      return ImportReport.parse({
        connections: bundle.connections.length,
        toolServers: bundle.toolServers.length,
        agents: created,
        warnings,
      });
    });
  }
}
