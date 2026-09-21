import type { PermissionPolicy, ToolDef } from '@comitiva/contract';

export type GateDecision = 'allow' | 'ask' | 'deny';

/** The key of an allow-always decision: `${toolServerId}:${toolName}` (the server's own tool name). */
export const approvalKey = (toolServerId: string, toolName: string): string =>
  `${toolServerId}:${toolName}`;

/** Read-only by the server's own annotation (MCP `readOnlyHint`). */
export const isReadOnly = (tool: ToolDef): boolean => tool.annotations?.readOnlyHint === true;

/**
 * Decides whether a tool call runs, asks the user, or is refused (SPEC §4.3):
 * read-only tools run; under the `read-only` policy anything else is refused;
 * a recorded allow-always or the `allow-writes` policy runs it; otherwise ask.
 * Tools without annotations are not read-only, so they ask.
 */
export class PermissionGate {
  private readonly always: Set<string>;

  constructor(
    private readonly policy: PermissionPolicy,
    alwaysAllowed: Iterable<string> = [],
  ) {
    this.always = new Set(alwaysAllowed);
  }

  check(toolServerId: string, tool: ToolDef): GateDecision {
    if (isReadOnly(tool)) return 'allow';
    if (this.policy === 'read-only') return 'deny';
    if (this.always.has(approvalKey(toolServerId, tool.name))) return 'allow';
    if (this.policy === 'allow-writes') return 'allow';
    return 'ask';
  }

  /** An allow-always decision made during the run applies to later calls in it. */
  remember(toolServerId: string, toolName: string): void {
    this.always.add(approvalKey(toolServerId, toolName));
  }
}
