import { z } from 'zod';
import { Block, UserContent } from '../blocks.js';
import { Id, IsoDate } from '../common.js';
import { AgentAvatar, AgentParams, AgentTags, PermissionPolicy } from '../entities/agent.js';
import { Conversation } from '../entities/conversation.js';
import { Message } from '../entities/message.js';
import { ApprovalDecision } from '../entities/tool-approval.js';
import { AppErrorShape } from '../errors.js';
import { ProviderId } from '../provider-config.js';
import {
  RunBlockEvent,
  RunTextDeltaEvent,
  RunToolCallEvent,
  RunToolResultEvent,
} from '../runner-protocol.js';
import {
  HubUser,
  HubUsageInput,
  InvitableRole,
  WorkspaceHeaderValue,
  WorkspaceRole,
} from './entities.js';

/**
 * Request and response bodies of the hub's REST API (`/api/v1`, docs in the
 * hub's docs/api.md). The hub validates against the JSON Schema generated from
 * these; errors come back as `{ error: AppErrorShape }`.
 */

/** Bumped when a change to the hub API breaks existing desktops. */
export const HUB_API_VERSION = 1;

export const HubEdition = z.enum(['community', 'cloud']);
export type HubEdition = z.infer<typeof HubEdition>;

export const HubMeta = z.object({
  apiVersion: z.number().int().positive(),
  edition: HubEdition,
  /** The `contract-v*` tag the hub's schemas were copied from. */
  contractVersion: z.string(),
  capabilities: z.object({
    /** Phase 9: the hub runs API connections itself. */
    execution: z.boolean(),
    registration: z.enum(['open', 'invite-only']),
  }),
});
export type HubMeta = z.infer<typeof HubMeta>;

const Email = z.email().max(255);
const Password = z.string().min(8).max(200);
const DeviceName = z.string().trim().min(1).max(100);

export const HubRegisterInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: Email,
  password: Password,
  deviceName: DeviceName,
  /** Required when registration is invite-only. */
  invitationToken: z.string().optional(),
});
export type HubRegisterInput = z.infer<typeof HubRegisterInput>;

export const HubLoginInput = z.object({
  email: Email,
  password: z.string().min(1).max(200),
  deviceName: DeviceName,
});
export type HubLoginInput = z.infer<typeof HubLoginInput>;

/** A personal access token for one device. The desktop keeps it in its SecretStore. */
export const HubAuthResult = z.object({ token: z.string().min(1), user: HubUser });
export type HubAuthResult = z.infer<typeof HubAuthResult>;

export const WorkspaceDraft = z.object({ name: z.string().trim().min(1).max(100) });
export type WorkspaceDraft = z.infer<typeof WorkspaceDraft>;

export const MemberPatch = z.object({ role: WorkspaceRole });
export type MemberPatch = z.infer<typeof MemberPatch>;

export const InvitationDraft = z.object({ email: Email, role: InvitableRole.default('member') });
export type InvitationDraft = z.input<typeof InvitationDraft>;

/** Returned once, when created: the link carries the token, which the hub keeps only hashed. */
export const InvitationCreated = z.object({
  id: Id,
  token: z.string().min(1),
  url: z.url(),
  expiresAt: IsoDate,
});
export type InvitationCreated = z.infer<typeof InvitationCreated>;

export const InvitationPreview = z.object({
  workspace: z.object({ id: Id, name: z.string() }),
  email: z.email(),
  role: InvitableRole,
  invitedBy: z.string(),
  expiresAt: IsoDate,
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;

const sharedAgentFields = {
  name: z.string().trim().min(1).max(100),
  avatar: AgentAvatar,
  provider: ProviderId,
  model: z.string().trim().max(200).nullable(),
  role: z.string().max(100_000),
  params: AgentParams,
  toolServerIds: z.array(Id).max(50),
  permissionPolicy: PermissionPolicy,
  tags: AgentTags,
};

export const SharedAgentDraft = z.object({
  ...sharedAgentFields,
  model: sharedAgentFields.model.default(null),
  role: sharedAgentFields.role.default(''),
  params: sharedAgentFields.params.default({}),
  toolServerIds: sharedAgentFields.toolServerIds.default([]),
  permissionPolicy: sharedAgentFields.permissionPolicy.default('ask'),
  tags: sharedAgentFields.tags.default([]),
});
export type SharedAgentDraft = z.input<typeof SharedAgentDraft>;

export const SharedAgentPatch = z.object(sharedAgentFields).partial();
export type SharedAgentPatch = z.input<typeof SharedAgentPatch>;

const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid header name');

export const WorkspaceToolServerDraft = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(HeaderName, WorkspaceHeaderValue).default({}),
  enabled: z.boolean().default(true),
});
export type WorkspaceToolServerDraft = z.input<typeof WorkspaceToolServerDraft>;

export const WorkspaceToolServerPatch = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(HeaderName, WorkspaceHeaderValue),
    enabled: z.boolean(),
  })
  .partial();
export type WorkspaceToolServerPatch = z.input<typeof WorkspaceToolServerPatch>;

export const HubConversationDraft = z.object({ agentId: Id });

/**
 * `titleSource: 'auto'` is a generated title: the hub applies it only while
 * the title is still the placeholder, so a rename by anyone wins.
 */
export const HubConversationPatch = z
  .object({
    title: z.string().trim().min(1).max(200),
    titleSource: z.enum(['user', 'auto']),
    archived: z.boolean(),
  })
  .partial();
export type HubConversationPatch = z.input<typeof HubConversationPatch>;

// -------------------------------------------------------------------- runs

/**
 * Starts a turn run by the caller's desktop. With `content`, a user message
 * and an empty streaming reply are written; without it, the last reply (which
 * must have failed) is reset for a retry. 409 `conversation_busy` when
 * another run holds the conversation.
 */
export const HubRunStartInput = z.object({
  runId: Id,
  content: UserContent.optional(),
});
export type HubRunStartInput = z.infer<typeof HubRunStartInput>;

export const HubRunStartResult = z.object({
  runId: Id,
  userMessage: Message.nullable(),
  reply: Message,
  conversation: Conversation,
  /** Every message before the reply, oldest first: what the runner gets. */
  history: z.array(Message),
  /** Seconds the run stays alive without events or heartbeats. */
  leaseSeconds: z.number().int().positive(),
});
export type HubRunStartResult = z.infer<typeof HubRunStartResult>;

/** The run events a desktop publishes, as the runner emitted them (RunnerEvent semantics). */
export const HubRunEvent = z.discriminatedUnion('type', [
  RunTextDeltaEvent,
  RunBlockEvent,
  RunToolCallEvent,
  RunToolResultEvent,
]);
export type HubRunEvent = z.infer<typeof HubRunEvent>;

/**
 * A batch of run events. `batch` counts from 1 per run; a batch at or below
 * the last one applied is acknowledged and ignored, so a retry never
 * duplicates text.
 */
export const HubRunEventsInput = z.object({
  batch: z.number().int().positive(),
  events: z.array(HubRunEvent).min(1).max(500),
});
export type HubRunEventsInput = z.infer<typeof HubRunEventsInput>;

export const HubRunApprovalInput = z.object({ toolUseId: z.string(), decision: ApprovalDecision });
export type HubRunApprovalInput = z.infer<typeof HubRunApprovalInput>;

/**
 * The end of a run: the reply's final blocks (authoritative over the streamed
 * events), its status and error, and the usage, written in one transaction.
 */
export const HubRunFinishInput = z.object({
  status: z.enum(['complete', 'cancelled', 'error']),
  content: z.array(Block),
  error: AppErrorShape.nullable(),
  usage: HubUsageInput.nullable(),
});
export type HubRunFinishInput = z.infer<typeof HubRunFinishInput>;

export const HubRunFinishResult = z.object({ message: Message, conversation: Conversation });
export type HubRunFinishResult = z.infer<typeof HubRunFinishResult>;

/** Error body of every failed hub request. */
export const HubErrorBody = z.object({ error: AppErrorShape });
export type HubErrorBody = z.infer<typeof HubErrorBody>;
