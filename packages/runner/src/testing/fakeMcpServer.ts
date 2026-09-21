import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { McpConnection, type OpenConnection } from '../mcp/McpConnection.js';

/**
 * An in-memory MCP server for tests, with tools that cover the permission
 * cases: `read_note` (readOnlyHint), `write_note` (no annotations: asks),
 * `delete_note` (destructiveHint), `slow` (waits for `ms` or the client's
 * cancel) and `crash` (the session dies mid-call).
 */
export interface FakeMcp {
  open: OpenConnection;
  /** How many sessions were opened (restarts count). */
  opens: () => number;
  /** Tool calls the fake received, in order. */
  calls: Array<{ server: string; tool: string; args: unknown }>;
  /** Notes written through write_note, per server id. */
  notes: Map<string, string>;
  /** Makes the next `n` opens fail (a server that cannot start). */
  failNextOpens(n: number): void;
  /** Extra args each open received (the filesystem server's roots). */
  args: string[][];
}

export function createFakeMcp(): FakeMcp {
  let opens = 0;
  let failing = 0;
  const calls: FakeMcp['calls'] = [];
  const notes = new Map<string, string>();
  const args: string[][] = [];

  const open: OpenConnection = async (launch, extraArgs) => {
    opens++;
    args.push(extraArgs);
    if (failing > 0) {
      failing--;
      throw new Error('spawn fake ENOENT');
    }
    const server = new McpServer({ name: `fake-${launch.id}`, version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const record = (tool: string, a: unknown) => calls.push({ server: launch.id, tool, args: a });

    server.registerTool(
      'read_note',
      {
        description: 'Reads the note',
        inputSchema: { key: z.string() },
        annotations: { readOnlyHint: true },
      },
      (a) => {
        record('read_note', a);
        return {
          content: [{ type: 'text', text: notes.get(`${launch.id}:${a.key}`) ?? '(empty)' }],
        };
      },
    );
    server.registerTool(
      'write_note',
      { description: 'Writes the note', inputSchema: { key: z.string(), text: z.string() } },
      (a) => {
        record('write_note', a);
        notes.set(`${launch.id}:${a.key}`, a.text);
        return { content: [{ type: 'text', text: `saved ${a.key}` }] };
      },
    );
    server.registerTool(
      'delete_note',
      {
        description: 'Deletes the note',
        inputSchema: { key: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      (a) => {
        record('delete_note', a);
        notes.delete(`${launch.id}:${a.key}`);
        return { content: [{ type: 'text', text: `deleted ${a.key}` }] };
      },
    );
    server.registerTool(
      'slow',
      {
        description: 'Takes a while',
        inputSchema: { ms: z.number() },
        annotations: { readOnlyHint: true },
      },
      async (a, extra) => {
        record('slow', a);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, a.ms);
          extra.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        return { content: [{ type: 'text', text: extra.signal.aborted ? 'aborted' : 'done' }] };
      },
    );
    server.registerTool(
      'crash',
      { description: 'Dies', inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => {
        record('crash', {});
        await serverSide.close();
        return { content: [] };
      },
    );
    await server.connect(serverSide);
    return McpConnection.connect(clientSide, launch.name);
  };

  return {
    open,
    opens: () => opens,
    calls,
    notes,
    failNextOpens: (n) => (failing = n),
    args,
  };
}
