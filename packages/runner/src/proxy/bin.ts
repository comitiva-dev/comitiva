import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '@comitiva/contract';
import type { BridgeFile, BridgeRequest, BridgeResponse } from '../mcp/ToolBridge.js';
import type { ToolResult } from '../providers/ProviderAdapter.js';
import { LineSplitter, encodeLine } from '../util/jsonl.js';
import { RUNNER_VERSION } from '../version.js';

/**
 * comitiva-mcp-proxy <bridge-file>: the only MCP server a CLI harness gets
 * (ADR 0009). It serves the run's tools over stdio and forwards every list and
 * call to the runner's ToolBridge, which applies the permission gate and asks
 * the user when needed. It holds no tools and no secrets of its own.
 */

type Payload =
  | { type: 'hello'; token: string }
  | { type: 'list' }
  | { type: 'call'; name: string; input: unknown; toolUseId?: string | undefined };

const log = (msg: string) => process.stderr.write(`[comitiva-mcp-proxy] ${msg}\n`);

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: mcp-proxy <bridge-file>');
  const { socket: path, token } = JSON.parse(readFileSync(file, 'utf8')) as BridgeFile;

  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map<number, (r: BridgeResponse) => void>();
  const splitter = new LineSplitter((line) => {
    const r = JSON.parse(line) as BridgeResponse;
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  socket.on('data', (chunk: Buffer) => splitter.push(chunk));
  // Without the runner there is nothing to serve.
  socket.on('close', () => process.exit(1));

  const rpc = (payload: Payload): Promise<Extract<BridgeResponse, { ok: true }>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (r) => (r.ok ? resolve(r) : reject(new Error(r.error))));
      socket.write(encodeLine({ ...payload, id } as BridgeRequest));
    });

  await rpc({ type: 'hello', token });

  const server = new Server(
    { name: 'comitiva', version: RUNNER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools = [] } = await rpc({ type: 'list' });
    return { tools: tools.map(toMcpTool) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      const { result } = await rpc({
        type: 'call',
        name: req.params.name,
        input: req.params.arguments ?? {},
        toolUseId: toolUseIdOf(req.params._meta),
      });
      return toMcpResult(result ?? { content: [], isError: false });
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

function toMcpTool(t: ToolDef) {
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: { type: 'object' as const, ...t.inputSchema },
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

function toMcpResult(r: ToolResult): CallToolResult {
  return {
    isError: r.isError,
    content: r.content.map((b) => {
      if (b.type === 'text') return { type: 'text' as const, text: b.text };
      if (b.source.kind === 'base64' && b.type === 'image') {
        return { type: 'image' as const, data: b.source.data, mimeType: b.source.mediaType };
      }
      return { type: 'text' as const, text: `[${b.type} not shown]` };
    }),
  };
}

/** Harnesses may tag calls with their own tool-use id in `_meta` (e.g. `claudecode/toolUseId`). */
function toolUseIdOf(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  for (const [key, value] of Object.entries(meta)) {
    if (/tool_?use_?id$/i.test(key) && typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

main().catch((err: unknown) => {
  log((err as Error).message);
  process.exit(1);
});
