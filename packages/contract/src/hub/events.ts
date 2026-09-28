import { z } from 'zod';
import { Block, ToolResultContentBlock } from '../blocks.js';
import { Id } from '../common.js';
import { Conversation } from '../entities/conversation.js';
import { Message } from '../entities/message.js';
import { ErrorCode } from '../errors.js';
import { StopReason } from '../runner-protocol.js';
import {
  HubPendingApproval,
  HubRunner,
  Member,
  SharedAgent,
  Workspace,
  WorkspaceToolServer,
} from './entities.js';

/**
 * What the hub broadcasts over Reverb (Pusher protocol). The Pusher event
 * name is the `type`. Channels:
 *
 * - `private-user.{userId}`: workspace.*
 * - `presence-workspace.{workspaceId}`: member.*, agent.*, tool_server.*,
 *   conversation.* (plus Pusher's own presence events)
 * - `private-conversation.{conversationId}`: message.*, run.*
 *
 * Run events mirror RunnerEvent. The ones that change a message
 * (`message.*`, `run.text_delta`, `run.block`, `run.tool_result`) carry the
 * conversation's `rev`, one per event, so a page fetched mid-stream lines up
 * with the stream (ADR 0008); the others carry none.
 */

const Rev = z.number().int().positive();
const RunRef = { conversationId: Id, messageId: Id, runId: Id };
const Changes = { ...RunRef, rev: Rev };

export const HubEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace.joined'), workspace: Workspace }),
  z.object({ type: z.literal('workspace.updated'), workspace: Workspace }),
  z.object({ type: z.literal('workspace.left'), workspaceId: Id }),

  z.object({ type: z.literal('member.added'), workspaceId: Id, member: Member }),
  z.object({ type: z.literal('member.updated'), workspaceId: Id, member: Member }),
  z.object({ type: z.literal('member.removed'), workspaceId: Id, userId: Id }),

  z.object({ type: z.literal('agent.created'), agent: SharedAgent }),
  z.object({ type: z.literal('agent.updated'), agent: SharedAgent }),
  z.object({ type: z.literal('agent.deleted'), workspaceId: Id, agentId: Id }),

  z.object({ type: z.literal('tool_server.created'), toolServer: WorkspaceToolServer }),
  z.object({ type: z.literal('tool_server.updated'), toolServer: WorkspaceToolServer }),
  z.object({ type: z.literal('tool_server.deleted'), workspaceId: Id, toolServerId: Id }),

  /** Unread counts are per member, so the list's `unread` is not in these. */
  z.object({
    type: z.literal('conversation.created'),
    workspaceId: Id,
    conversation: Conversation,
    pendingApproval: HubPendingApproval.nullable(),
    runner: HubRunner.nullable(),
  }),
  z.object({
    type: z.literal('conversation.updated'),
    workspaceId: Id,
    conversation: Conversation,
    pendingApproval: HubPendingApproval.nullable(),
    runner: HubRunner.nullable(),
  }),

  z.object({ type: z.literal('message.created'), message: Message, rev: Rev }),
  z.object({ type: z.literal('message.updated'), message: Message, rev: Rev }),

  z.object({ type: z.literal('run.started'), ...RunRef, userId: Id }),
  z.object({
    type: z.literal('run.text_delta'),
    ...Changes,
    text: z.string(),
    /** When the executing desktop's runner emitted it (epoch ms), for latency. */
    ts: z.number().optional(),
  }),
  z.object({ type: z.literal('run.block'), ...Changes, block: Block }),
  z.object({
    type: z.literal('run.tool_call'),
    ...RunRef,
    toolUseId: z.string(),
    toolServerId: Id,
    toolName: z.string(),
    input: z.unknown(),
    requiresApproval: z.boolean(),
  }),
  z.object({
    type: z.literal('run.tool_result'),
    ...Changes,
    toolUseId: z.string(),
    output: z.array(ToolResultContentBlock),
    isError: z.boolean(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('run.done'), ...RunRef, stopReason: StopReason }),
  z.object({
    type: z.literal('run.error'),
    ...RunRef,
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
  }),
  /** Someone asked the executing desktop to stop; it cancels its runner. */
  z.object({
    type: z.literal('run.cancel_requested'),
    conversationId: Id,
    runId: Id,
    byUserId: Id,
  }),
]);
export type HubEvent = z.infer<typeof HubEvent>;
export type HubEventType = HubEvent['type'];
