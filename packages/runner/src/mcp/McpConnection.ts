import type { ToolDef, ToolServerLaunch } from '@comitiva/contract';
import { AppError } from '@comitiva/contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolResult } from '../providers/ProviderAdapter.js';
import { RUNNER_VERSION } from '../version.js';
import { toToolDef, toToolResult } from './content.js';

export const START_TIMEOUT_MS = 30_000;
/** A single tool call (after any approval); long jobs keep it alive with progress notifications. */
export const CALL_TIMEOUT_MS = 10 * 60_000;

/** How the manager opens a connection (tests inject in-memory servers). */
export type OpenConnection = (
  launch: ToolServerLaunch,
  extraArgs: string[],
  log: (msg: string) => void,
) => Promise<McpConnection>;

/**
 * One live MCP client session with one server process (stdio) or endpoint
 * (http). It lists tools once at start. `onClose` fires when the session ends
 * for any reason other than `close()`.
 */
export class McpConnection {
  private closedByUs = false;
  private closeHandlers: Array<() => void> = [];
  alive = true;

  private constructor(
    private readonly client: Client,
    readonly tools: ToolDef[],
  ) {
    client.onclose = () => {
      this.alive = false;
      if (!this.closedByUs) for (const h of this.closeHandlers) h();
    };
  }

  /** Connects over `transport`, lists tools; fails with tool_server_failed. */
  static async connect(transport: Transport, label: string): Promise<McpConnection> {
    const client = new Client({ name: 'comitiva-runner', version: RUNNER_VERSION });
    try {
      await client.connect(transport, { timeout: START_TIMEOUT_MS });
      const tools: ToolDef[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: START_TIMEOUT_MS,
        });
        tools.push(...page.tools.map(toToolDef));
        cursor = page.nextCursor;
      } while (cursor);
      return new McpConnection(client, tools);
    } catch (err) {
      await client.close().catch(() => {});
      throw new AppError(
        'tool_server_failed',
        `${label} did not start: ${(err as Error).message}`,
        {
          retryable: true,
          cause: err,
        },
      );
    }
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** Throws when the session fails (closed, protocol error) or the signal aborts. */
  async call(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const result = await this.client.callTool(
      { name, arguments: (input ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
    );
    return toToolResult(result as Parameters<typeof toToolResult>[0]);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.alive = false;
    await this.client.close().catch(() => {});
  }
}

/** Opens stdio servers as child processes and http servers over Streamable HTTP. */
export const openConnection: OpenConnection = async (launch, extraArgs, log) => {
  if (launch.transport === 'http') {
    const transport = new StreamableHTTPClientTransport(new URL(launch.url), {
      requestInit: { headers: launch.headers },
    });
    // The SDK's optional `sessionId` trips exactOptionalPropertyTypes; the shape is right.
    return McpConnection.connect(transport as Transport, launch.name);
  }
  // Only the default safe variables (HOME, PATH, …) plus the server's own env:
  // provider keys and Comitiva's variables never reach a tool server.
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args, ...extraArgs],
    env: { ...getDefaultEnvironment(), ...launch.env },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) =>
    log(chunk.toString('utf8').trimEnd().slice(0, 2000)),
  );
  return McpConnection.connect(transport, launch.name);
};
