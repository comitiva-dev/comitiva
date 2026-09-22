import { z } from 'zod';
import { Block, ToolResultContentBlock } from './blocks.js';
import { Id } from './common.js';
import { Agent, AgentRoot } from './entities/agent.js';
import { Connection } from './entities/connection.js';
import { Message } from './entities/message.js';
import { ApprovalDecision } from './entities/tool-approval.js';
import { BuiltinToolServer } from './entities/tool-server.js';
import { AppErrorShape } from './errors.js';
import { ProviderId } from './provider-config.js';

/**
 * Runner protocol: JSON lines over stdin (requests) and stdout (events).
 * One JSON object per line. See docs/architecture.md.
 */
export const PROTOCOL_VERSION = 1;

const req = { id: z.string().min(1) };

export const PingRequest = z.object({ ...req, type: z.literal('ping') });
export const ConnectionTestRequest = z.object({
  ...req,
  type: z.literal('connection.test'),
  connection: Connection,
  secret: z.string().optional(),
});
export const ConnectionListModelsRequest = z.object({
  ...req,
  type: z.literal('connection.listModels'),
  connection: Connection,
  secret: z.string().optional(),
});
/**
 * How the runner launches one MCP server: a ToolServer with its secrets
 * resolved by the shell (values travel per request and are never persisted by
 * the runner). `builtin` servers get extra arguments from the runner (the
 * filesystem server gets the agent's roots).
 */
export const ToolServerLaunch = z.discriminatedUnion('transport', [
  z.object({
    id: Id,
    name: z.string().min(1),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    builtin: BuiltinToolServer.optional(),
  }),
  z.object({
    id: Id,
    name: z.string().min(1),
    transport: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type ToolServerLaunch = z.infer<typeof ToolServerLaunch>;

/** Starts (or reuses) an MCP client and returns the server's tools. */
export const ToolServerStartRequest = z.object({
  ...req,
  type: z.literal('toolServer.start'),
  toolServer: ToolServerLaunch,
  /** Built-in filesystem server: the roots it serves (none → every path is refused). */
  roots: z.array(AgentRoot).optional(),
});
export const ToolServerStopRequest = z.object({
  ...req,
  type: z.literal('toolServer.stop'),
  toolServerId: Id,
});
export const RunStartRequest = z.object({
  ...req,
  type: z.literal('run.start'),
  runId: Id,
  conversationId: Id,
  agent: Agent,
  connection: Connection,
  secret: z.string().optional(),
  messages: z.array(Message),
  harnessSessionId: z.string().optional(),
  /**
   * CLI harnesses: absolute directory the harness runs in (the runner creates
   * it). The shell resolves it; API connections ignore it.
   */
  workingDirectory: z.string().optional(),
  /** `${toolServerId}:${toolName}` pairs with a recorded allow-always decision. */
  alwaysAllowed: z.array(z.string()).optional(),
  /** The agent's enabled MCP servers, resolved by the shell (Phase 5). */
  toolServers: z.array(ToolServerLaunch).optional(),
});
/** Finds a CLI harness binary and reads its version (the form's "Detect"). */
export const CliDetectRequest = z.object({
  ...req,
  type: z.literal('cli.detect'),
  provider: ProviderId,
  binaryPath: z.string().optional(),
});
export const RunCancelRequest = z.object({ ...req, type: z.literal('run.cancel'), runId: Id });
export const RunApprovalRequest = z.object({
  ...req,
  type: z.literal('run.approval'),
  runId: Id,
  toolUseId: z.string(),
  decision: ApprovalDecision,
});
export const ShutdownRequest = z.object({ ...req, type: z.literal('shutdown') });

export const RunnerRequest = z.discriminatedUnion('type', [
  PingRequest,
  ConnectionTestRequest,
  ConnectionListModelsRequest,
  CliDetectRequest,
  ToolServerStartRequest,
  ToolServerStopRequest,
  RunStartRequest,
  RunCancelRequest,
  RunApprovalRequest,
  ShutdownRequest,
]);
export type RunnerRequest = z.infer<typeof RunnerRequest>;
export type RunnerRequestType = RunnerRequest['type'];
export type RunStartRequest = z.infer<typeof RunStartRequest>;
export type ToolServerStartRequest = z.infer<typeof ToolServerStartRequest>;
export type ConnectionTestRequest = z.infer<typeof ConnectionTestRequest>;
export type CliDetectRequest = z.infer<typeof CliDetectRequest>;

// ---------------------------------------------------------------- results

export const PingResult = z.object({ version: z.string(), protocolVersion: z.number().int() });
export type PingResult = z.infer<typeof PingResult>;

export const TestResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), latencyMs: z.number().nonnegative() }),
  z.object({ ok: z.literal(false), error: AppErrorShape }),
]);
export type TestResult = z.infer<typeof TestResult>;

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** MCP tool annotations (hints from the server; only `readOnlyHint` affects the permission gate). */
export const ToolAnnotations = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotations>;

export const ToolDef = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: ToolAnnotations.optional(),
});
export type ToolDef = z.infer<typeof ToolDef>;

export const ToolServerStartResult = z.array(ToolDef);
export type ToolServerStartResult = z.infer<typeof ToolServerStartResult>;

export const CliDetectResult = z.object({ path: z.string(), version: z.string() });
export type CliDetectResult = z.infer<typeof CliDetectResult>;

export const RunStartResult = z.object({ runId: Id });
export type RunStartResult = z.infer<typeof RunStartResult>;

// ----------------------------------------------------------------- events

export const StopReason = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'refusal',
  'pause_turn',
  'max_iterations',
  'cancelled',
  'other',
]);
export type StopReason = z.infer<typeof StopReason>;

const run = {
  runId: Id,
  /** Emission time in epoch milliseconds (sub-ms precision), used for latency measurement. */
  ts: z.number().optional(),
};

export const ResponseEvent = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('response'),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: AppErrorShape,
  }),
]);
export const RunSessionEvent = z.object({
  ...run,
  type: z.literal('run.session'),
  harnessSessionId: z.string(),
});
export const RunTextDeltaEvent = z.object({
  ...run,
  type: z.literal('run.text_delta'),
  text: z.string(),
});
export const RunBlockEvent = z.object({ ...run, type: z.literal('run.block'), block: Block });
/**
 * A tool call the model made, after the matching `run.block` tool_use. With
 * `requiresApproval` the runner waits for `run.approval` before calling it.
 * `toolName` is the server's own tool name (the block carries the prefixed one).
 */
export const RunToolCallEvent = z.object({
  ...run,
  type: z.literal('run.tool_call'),
  toolUseId: z.string(),
  toolServerId: Id,
  toolName: z.string(),
  input: z.unknown(),
  requiresApproval: z.boolean(),
});
/** The outcome of a tool call; shells store it as a `tool_result` block. */
export const RunToolResultEvent = z.object({
  ...run,
  type: z.literal('run.tool_result'),
  toolUseId: z.string(),
  output: z.array(ToolResultContentBlock),
  isError: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export const RunUsageEvent = z.object({
  ...run,
  type: z.literal('run.usage'),
  /** Net of `cacheReadTokens`: every adapter normalizes to that. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  estimated: z.boolean(),
  /** What the provider or harness actually ran; the shell's model is a fallback. */
  model: z.string().optional(),
  /** Cost the harness computed itself (Claude Code); authoritative when present. */
  reportedCostUsd: z.number().nonnegative().optional(),
});
export const RunDoneEvent = z.object({
  ...run,
  type: z.literal('run.done'),
  stopReason: StopReason,
});
export const RunErrorEvent = z.object({
  ...run,
  type: z.literal('run.error'),
  code: AppErrorShape.shape.code,
  message: z.string(),
  retryable: z.boolean(),
});
export const LogEvent = z.object({
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
});

export const RunEvent = z.discriminatedUnion('type', [
  RunSessionEvent,
  RunTextDeltaEvent,
  RunBlockEvent,
  RunToolCallEvent,
  RunToolResultEvent,
  RunUsageEvent,
  RunDoneEvent,
  RunErrorEvent,
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const RunnerEvent = z.union([ResponseEvent, RunEvent, LogEvent]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
export type ResponseEvent = z.infer<typeof ResponseEvent>;
export type RunTextDeltaEvent = z.infer<typeof RunTextDeltaEvent>;
export type RunToolCallEvent = z.infer<typeof RunToolCallEvent>;
export type RunToolResultEvent = z.infer<typeof RunToolResultEvent>;
export type RunUsageEvent = z.infer<typeof RunUsageEvent>;
export type RunDoneEvent = z.infer<typeof RunDoneEvent>;
export type RunErrorEvent = z.infer<typeof RunErrorEvent>;
export type LogEvent = z.infer<typeof LogEvent>;

/** Distributes Omit over a union so each variant keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A run event before the runner stamps `runId` and `ts`. */
export type RunEventPayload = DistributiveOmit<RunEvent, 'runId' | 'ts'>;

export function isRunEvent(e: RunnerEvent): e is RunEvent {
  return e.type.startsWith('run.');
}
