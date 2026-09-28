import { z } from 'zod';
import { Id, IsoDate } from '../common.js';
import {
  AgentAvatar,
  AgentParams,
  AgentRoot,
  AgentTags,
  PermissionPolicy,
} from '../entities/agent.js';
import { Conversation } from '../entities/conversation.js';
import { CostSource, UsageRecord } from '../entities/usage-record.js';
import { ProviderId } from '../provider-config.js';

/**
 * Entities of the Laravel hub (Phase 8, ADR 0017). The hub is the source of
 * truth for shared workspaces; what only makes sense on one machine
 * (connections and keys, folders, stdio servers, harness sessions) stays on
 * each desktop.
 */

export const WorkspaceRole = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/** Roles an invitation can grant; ownership is given to an existing member. */
export const InvitableRole = z.enum(['admin', 'member']);
export type InvitableRole = z.infer<typeof InvitableRole>;

export const HubUser = z.object({
  id: Id,
  name: z.string().min(1),
  email: z.email(),
});
export type HubUser = z.infer<typeof HubUser>;

/** A workspace as its member sees it: `role` is the caller's own. */
export const Workspace = z.object({
  id: Id,
  name: z.string().min(1).max(100),
  role: WorkspaceRole,
  createdAt: IsoDate,
});
export type Workspace = z.infer<typeof Workspace>;

export const Member = z.object({
  user: HubUser,
  role: WorkspaceRole,
  joinedAt: IsoDate,
});
export type Member = z.infer<typeof Member>;

export const Invitation = z.object({
  id: Id,
  workspaceId: Id,
  email: z.email(),
  role: InvitableRole,
  invitedBy: HubUser,
  expiresAt: IsoDate,
  createdAt: IsoDate,
});
export type Invitation = z.infer<typeof Invitation>;

/**
 * An agent shared in a workspace. It names a provider and model instead of a
 * connection: each member links it to one of their own local connections
 * (`AgentLink`), and whoever sends a message runs it on their desktop.
 */
export const SharedAgent = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1),
  avatar: AgentAvatar,
  provider: ProviderId,
  model: z.string().nullable(),
  role: z.string(),
  params: AgentParams,
  /** Workspace tool servers (http only). Each member may add local ones in their link. */
  toolServerIds: z.array(Id),
  permissionPolicy: PermissionPolicy,
  tags: AgentTags,
  /** Null once that account is deleted. */
  createdBy: Id.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type SharedAgent = z.infer<typeof SharedAgent>;

/**
 * A header value of a workspace tool server: a plain value, or a secret each
 * member keeps on their own machine (the hub never stores its value).
 */
export const WorkspaceHeaderValue = z.union([
  z.object({ value: z.string() }),
  z.object({ secretRef: z.literal('member') }),
]);
export type WorkspaceHeaderValue = z.infer<typeof WorkspaceHeaderValue>;

/** A tool server shared in a workspace. Only `http`: stdio servers exist on one machine. */
export const WorkspaceToolServer = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.url(),
  headers: z.record(z.string(), WorkspaceHeaderValue),
  enabled: z.boolean(),
  createdBy: Id.nullable(),
  createdAt: IsoDate,
});
export type WorkspaceToolServer = z.infer<typeof WorkspaceToolServer>;

/** The member whose desktop is running a conversation's reply. */
export const HubRunner = z.object({
  userId: Id,
  name: z.string(),
  runId: Id,
  startedAt: IsoDate,
});
export type HubRunner = z.infer<typeof HubRunner>;

/**
 * A pending tool call as the hub shows it. Only the member whose desktop runs
 * the turn can answer it: the call acts on their machine.
 */
export const HubPendingApproval = z.object({
  toolUseId: z.string(),
  toolServerId: Id,
  toolName: z.string(),
  input: z.unknown(),
});

/** A conversation as a workspace list shows it; `unread` is the caller's. */
export const HubConversationSummary = z.object({
  conversation: Conversation,
  workspaceId: Id,
  unread: z.number().int().nonnegative(),
  pendingApproval: HubPendingApproval.nullable(),
  runner: HubRunner.nullable(),
});
export type HubConversationSummary = z.infer<typeof HubConversationSummary>;

/**
 * Usage a desktop reported for a run it executed in a workspace. Its cost was
 * frozen by that desktop when written (ADR 0011); it is shown, not billed
 * (ADR 0015). There is no connection: connections are local.
 */
export const HubUsageRecord = UsageRecord.omit({ connectionId: true }).extend({
  workspaceId: Id,
  /** The member whose desktop ran it; null once that account is deleted. */
  userId: Id.nullable(),
});
export type HubUsageRecord = z.infer<typeof HubUsageRecord>;

/** What the executing desktop reports when a run ends. */
export const HubUsageInput = z.object({
  provider: ProviderId,
  model: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  estimated: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  costSource: CostSource.nullable(),
  costEstimated: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type HubUsageInput = z.infer<typeof HubUsageInput>;

/**
 * How one member runs a shared agent on their desktop. Kept locally, never
 * sent to the hub: a local connection, folders and local tool servers.
 */
export const AgentLink = z.object({
  agentId: Id,
  workspaceId: Id,
  connectionId: Id.nullable(),
  roots: z.array(AgentRoot),
  toolServerIds: z.array(Id),
});
export type AgentLink = z.infer<typeof AgentLink>;

/** Someone online in a workspace (Reverb presence). */
export const PresenceMember = z.object({ userId: Id, name: z.string() });
export type PresenceMember = z.infer<typeof PresenceMember>;
