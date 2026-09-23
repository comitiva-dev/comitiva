import { z } from 'zod';
import { IsoDate } from './common.js';
import {
  AgentAvatar,
  AgentParams,
  AgentRoot,
  AgentTags,
  PermissionPolicy,
} from './entities/agent.js';
import { ToolServerTransport } from './entities/tool-server.js';
import { ErrorCode } from './errors.js';
import { ProviderId } from './provider-config.js';

/**
 * A portable bundle of agents, connections and tool servers (ADR 0013): what
 * one Comitiva exports and another imports, desktop or hub. It never carries
 * a secret or a secret reference: it records that a connection had a key and
 * which env and header values are secret, so the importer can ask for them.
 * Objects point at each other by `ref`, local to the bundle; built-in tool
 * servers are referenced by their fixed ids (`filesystem`, `google-drive`).
 */

export const BUNDLE_FORMAT = 'comitiva.bundle';
export const BUNDLE_VERSION = 1;

const Ref = z.string().min(1).max(64);

export const PortableConnection = z.object({
  ref: Ref,
  name: z.string().min(1),
  provider: ProviderId,
  kind: z.enum(['api', 'cli']),
  enabled: z.boolean(),
  /** The provider's config (validated against it on import). */
  config: z.record(z.string(), z.unknown()),
  /** It had an API key, which is not in the bundle. */
  hadKey: z.boolean(),
});
export type PortableConnection = z.infer<typeof PortableConnection>;

/** A plain value, or the marker of a secret whose value stays behind. */
export const PortableValue = z.union([
  z.object({ value: z.string() }),
  z.object({ secret: z.literal(true) }),
]);
export type PortableValue = z.infer<typeof PortableValue>;

export const PortableToolServer = z.object({
  ref: Ref,
  name: z.string().min(1),
  transport: ToolServerTransport,
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string(), PortableValue),
  url: z.string().nullable(),
  headers: z.record(z.string(), PortableValue),
  enabled: z.boolean(),
});
export type PortableToolServer = z.infer<typeof PortableToolServer>;

export const PortableAgent = z.object({
  name: z.string().min(1),
  avatar: AgentAvatar,
  connectionRef: Ref,
  model: z.string().nullable(),
  role: z.string(),
  params: AgentParams,
  tags: AgentTags,
  /** Refs of the bundle's tool servers, or a built-in server's id. */
  toolServerRefs: z.array(Ref),
  roots: z.array(AgentRoot),
  permissionPolicy: PermissionPolicy,
});
export type PortableAgent = z.infer<typeof PortableAgent>;

export const PortableBundle = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: IsoDate,
  app: z.object({ name: z.string(), version: z.string() }),
  connections: z.array(PortableConnection),
  toolServers: z.array(PortableToolServer),
  agents: z.array(PortableAgent),
});
export type PortableBundle = z.infer<typeof PortableBundle>;

/** Something the user has to finish after an import; nothing failed silently. */
export const ImportWarning = z.object({
  code: z.enum([
    'key_needed',
    'secret_needed',
    'root_missing',
    'binary_not_found',
    'agent_skipped',
  ]),
  /** The connection, tool server or agent it is about. */
  subject: z.string(),
  /** The env or header name, the folder, or (agent_skipped) the error code. */
  detail: z.string().nullable(),
  /** agent_skipped: why. */
  error: ErrorCode.nullable().default(null),
});
export type ImportWarning = z.infer<typeof ImportWarning>;

export const ImportReport = z.object({
  connections: z.number().int().nonnegative(),
  toolServers: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  warnings: z.array(ImportWarning),
});
export type ImportReport = z.infer<typeof ImportReport>;
