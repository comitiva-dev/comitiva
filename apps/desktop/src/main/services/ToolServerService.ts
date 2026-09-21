import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import {
  AppError,
  FILESYSTEM_TOOL_SERVER_ID,
  type Agent,
  type ToolDef,
  type ToolServer,
  type ToolServerLaunch,
  type ToolServerValueInput,
  type ValidToolServerDraft,
  type ValidToolServerPatch,
  type ValueOrSecret,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type { ToolServerRepository } from '../db/repositories/ToolServerRepository';
import type { SecretStore } from '../secrets/SecretStore';

/** How the shell starts a built-in server: its own Node binary and the bundled script. */
export interface BuiltinLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolServerServiceDeps {
  repo: ToolServerRepository;
  secrets: SecretStore;
  runner: Pick<RunnerClient, 'startToolServer' | 'stopToolServer'>;
  /** The built-in filesystem server's launch (paths differ in dev and packaged builds). */
  filesystem: BuiltinLaunch;
}

type Kind = 'env' | 'header';

/**
 * MCP servers: the built-in filesystem server and the ones the user adds.
 * Secret env vars and headers go to the SecretStore under
 * `toolServer:<id>:<env|header>:<NAME>`; SQLite and the renderer only see the
 * ref. Values are resolved into a ToolServerLaunch per request, for the runner.
 */
export class ToolServerService {
  constructor(private readonly deps: ToolServerServiceDeps) {}

  list(): ToolServer[] {
    return this.deps.repo.list();
  }

  async create(draft: ValidToolServerDraft): Promise<ToolServer> {
    const id = ulid();
    const spec = draft.spec;
    const written: string[] = [];
    try {
      const values =
        spec.transport === 'stdio'
          ? { env: await this.store(id, 'env', spec.env, {}, written), headers: {} }
          : { env: {}, headers: await this.store(id, 'header', spec.headers, {}, written) };
      return this.deps.repo.create({
        id,
        name: draft.name,
        transport: spec.transport,
        command: spec.transport === 'stdio' ? spec.command : null,
        args: spec.transport === 'stdio' ? spec.args : [],
        url: spec.transport === 'http' ? spec.url : null,
        enabled: draft.enabled,
        ...values,
      });
    } catch (err) {
      await Promise.all(written.map((ref) => this.deps.secrets.delete(ref)));
      throw err;
    }
  }

  /**
   * Built-ins accept only `enabled`. A new `spec` replaces the old one; a
   * `keepSecret` entry keeps the stored secret of the same name, and secrets
   * no longer used are deleted. The runner drops the old client, so the next
   * run starts the server with the new settings.
   */
  async update(id: string, patch: ValidToolServerPatch): Promise<ToolServer> {
    const current = this.deps.repo.require(id);
    if (current.builtin && (patch.name !== undefined || patch.spec !== undefined)) {
      throw new AppError('invalid_request', 'Built-in servers can only be enabled or disabled');
    }
    const written: string[] = [];
    let next: ToolServer;
    try {
      const spec = patch.spec;
      const changes = spec
        ? spec.transport === 'stdio'
          ? {
              transport: spec.transport,
              command: spec.command,
              args: spec.args,
              url: null,
              env: await this.store(id, 'env', spec.env, current.env, written),
              headers: {},
            }
          : {
              transport: spec.transport,
              command: null,
              args: [],
              url: spec.url,
              env: {},
              headers: await this.store(id, 'header', spec.headers, current.headers, written),
            }
        : {};
      next = this.deps.repo.update(id, {
        ...changes,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
    } catch (err) {
      // Refs the server already had were overwritten in place: keep them.
      const existing = new Set(refsOf(current));
      await Promise.all(
        written.filter((ref) => !existing.has(ref)).map((ref) => this.deps.secrets.delete(ref)),
      );
      throw err;
    }
    const kept = new Set(refsOf(next));
    await Promise.all(
      refsOf(current)
        .filter((ref) => !kept.has(ref))
        .map((ref) => this.deps.secrets.delete(ref)),
    );
    this.stopInRunner(id);
    return next;
  }

  async delete(id: string): Promise<void> {
    const server = this.deps.repo.require(id);
    this.deps.repo.delete(id);
    await Promise.all(refsOf(server).map((ref) => this.deps.secrets.delete(ref)));
    this.stopInRunner(id);
  }

  /**
   * Starts the server in the runner and lists its tools. The filesystem
   * server gets a throwaway read-write root so every tool shows.
   */
  async test(id: string): Promise<ToolDef[]> {
    const server = this.deps.repo.require(id);
    const toolServer = await this.launch(server);
    const roots =
      server.id === FILESYSTEM_TOOL_SERVER_ID
        ? [{ path: tmpdir(), mode: 'readwrite' as const }]
        : [];
    return this.deps.runner.startToolServer({ toolServer, roots });
  }

  /**
   * The launches for a run: the agent's enabled servers, secrets resolved.
   * The filesystem server is skipped for an agent without roots (it would
   * refuse every path). Throws `secret_missing` when a stored secret is gone.
   */
  async launchesFor(agent: Agent): Promise<ToolServerLaunch[]> {
    const launches: ToolServerLaunch[] = [];
    for (const id of agent.toolServerIds) {
      const server = this.deps.repo.get(id);
      if (!server?.enabled) continue;
      if (server.id === FILESYSTEM_TOOL_SERVER_ID && agent.roots.length === 0) continue;
      launches.push(await this.launch(server));
    }
    return launches;
  }

  private async launch(server: ToolServer): Promise<ToolServerLaunch> {
    if (server.id === FILESYSTEM_TOOL_SERVER_ID) {
      return {
        id: server.id,
        name: server.name,
        transport: 'stdio',
        builtin: 'filesystem',
        ...this.deps.filesystem,
      };
    }
    if (server.transport === 'http') {
      if (!server.url) throw new AppError('invalid_request', `${server.name} has no URL`);
      return {
        id: server.id,
        name: server.name,
        transport: 'http',
        url: server.url,
        headers: await this.resolve(server, server.headers),
      };
    }
    if (!server.command) throw new AppError('invalid_request', `${server.name} has no command`);
    return {
      id: server.id,
      name: server.name,
      transport: 'stdio',
      command: server.command,
      args: server.args,
      env: await this.resolve(server, server.env),
    };
  }

  private async resolve(
    server: ToolServer,
    values: Record<string, ValueOrSecret>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(values)) {
      if ('value' in v) {
        out[name] = v.value;
        continue;
      }
      const secret = await this.deps.secrets.get(v.secretRef);
      if (secret === null) {
        throw new AppError('secret_missing', `${server.name}: the secret ${name} is missing`);
      }
      out[name] = secret;
    }
    return out;
  }

  /** Form values → stored values; new secrets go to the SecretStore (refs recorded in `written`). */
  private async store(
    id: string,
    kind: Kind,
    input: Record<string, ToolServerValueInput>,
    current: Record<string, ValueOrSecret>,
    written: string[],
  ): Promise<Record<string, ValueOrSecret>> {
    const out: Record<string, ValueOrSecret> = {};
    for (const [name, v] of Object.entries(input)) {
      if ('value' in v) out[name] = { value: v.value };
      else if ('secret' in v) {
        const ref = `toolServer:${id}:${kind}:${name}`;
        await this.deps.secrets.set(ref, v.secret);
        written.push(ref);
        out[name] = { secretRef: ref };
      } else {
        const kept = current[name];
        if (!kept || !('secretRef' in kept)) {
          throw new AppError('invalid_request', `There is no stored secret for ${name}`);
        }
        out[name] = kept;
      }
    }
    return out;
  }

  private stopInRunner(id: string): void {
    this.deps.runner.stopToolServer(id).catch(() => {});
  }
}

function refsOf(server: ToolServer): string[] {
  return [...Object.values(server.env), ...Object.values(server.headers)].flatMap((v) =>
    'secretRef' in v ? [v.secretRef] : [],
  );
}
