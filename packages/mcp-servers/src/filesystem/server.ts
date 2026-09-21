import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as ops from './operations.js';
import { GuardError, RootGuard, type Root } from './RootGuard.js';

export interface FilesystemServerOptions {
  roots: Root[];
  /**
   * The MCP client (Comitiva's runner) asks the user before every write call,
   * so the server may register write tools. Without it the server is
   * read-only: a stray launch can never write (docs/tools.md).
   */
  gatedByClient: boolean;
  version?: string;
  warn?: (msg: string) => void;
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/**
 * The built-in `filesystem` MCP server. Every path goes through RootGuard:
 * outside the roots is refused here, not only in the UI. Errors come back as
 * tool results with the stable code first (`outside_roots: …`), so the model
 * can react and the shell can show them.
 */
export async function createFilesystemServer(opts: FilesystemServerOptions): Promise<McpServer> {
  const guard = await RootGuard.create(opts.roots, opts.warn);
  const server = new McpServer(
    { name: 'comitiva-filesystem', version: opts.version ?? '0.1.0' },
    { instructions: describeRoots(guard) },
  );
  const where = describeRoots(guard);
  const writable = opts.gatedByClient && guard.roots.some((r) => r.mode === 'readwrite');

  server.registerTool(
    'list_dir',
    {
      title: 'List folder',
      description: `Lists a folder's files and subfolders. Without a path, lists the folders you can use. ${where}`,
      inputSchema: {
        path: z.string().optional().describe('Absolute, or relative to the first folder'),
      },
      annotations: READ,
    },
    ({ path }) => run(() => ops.listDir(guard, path)),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: `Reads a text file (optionally a range of lines) or an image. ${where}`,
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).optional().describe('First line to return (0-based)'),
        limit: z.number().int().min(1).optional().describe('How many lines to return'),
      },
      annotations: READ,
    },
    ({ path, offset, limit }) => run(() => ops.readTextOrImage(guard, path, { offset, limit })),
  );

  server.registerTool(
    'search',
    {
      title: 'Search files',
      description:
        'Finds files by name (glob: *, ?, **) and optionally by text they contain (case-insensitive). ' +
        `Without a path, searches every folder. ${where}`,
      inputSchema: {
        path: z.string().optional(),
        pattern: z.string().optional().describe('Glob on names or relative paths, e.g. **/*.md'),
        query: z.string().optional().describe('Text the file must contain'),
      },
      annotations: READ,
    },
    (args) => run(() => ops.search(guard, args)),
  );

  if (writable) {
    server.registerTool(
      'write_file',
      {
        title: 'Write file',
        description:
          'Creates a text file, or replaces its whole content. Missing folders are created.',
        inputSchema: { path: z.string(), content: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      ({ path, content }) => run(() => ops.writeTextFile(guard, path, content)),
    );
    server.registerTool(
      'create_dir',
      {
        title: 'Create folder',
        description: 'Creates a folder (and its missing parents).',
        inputSchema: { path: z.string() },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      ({ path }) => run(() => ops.createDir(guard, path)),
    );
    server.registerTool(
      'move',
      {
        title: 'Move or rename',
        description:
          'Moves or renames a file or folder. Refuses to replace an existing target unless overwrite is true.',
        inputSchema: { from: z.string(), to: z.string(), overwrite: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      ({ from, to, overwrite }) => run(() => ops.move(guard, from, to, overwrite)),
    );
    server.registerTool(
      'delete',
      {
        title: 'Delete',
        description: 'Deletes a file, or a folder and everything in it when recursive is true.',
        inputSchema: { path: z.string(), recursive: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      ({ path, recursive }) => run(() => ops.remove(guard, path, recursive)),
    );
  }
  return server;
}

function describeRoots(guard: RootGuard): string {
  if (guard.roots.length === 0) return 'No folders are available.';
  const list = guard.roots
    .map((r) => `${r.real} (${r.mode === 'readwrite' ? 'read-write' : 'read-only'})`)
    .join(', ');
  return `Folders: ${list}.`;
}

async function run(fn: () => Promise<ops.Content[]>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (err) {
    const code = err instanceof GuardError ? err.code : fsCode(err);
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
  }
}

function fsCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    ? 'not_found'
    : 'tool_failed';
}

/** `--root <path>:<mode>` (repeatable; mode read | readwrite, default read) and `--gated-by-client`. */
export function parseArgs(argv: readonly string[]): { roots: Root[]; gatedByClient: boolean } {
  const roots: Root[] = [];
  let gatedByClient = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--gated-by-client') gatedByClient = true;
    else if (arg === '--root') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--root needs <path>:<mode>');
      roots.push(parseRoot(value));
    } else if (arg.startsWith('--root=')) roots.push(parseRoot(arg.slice('--root='.length)));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { roots, gatedByClient };
}

function parseRoot(value: string): Root {
  // The mode is after the last colon, so Windows drive letters (C:\x) survive.
  const m = /^(.*):(read|readwrite)$/.exec(value);
  return m ? { path: m[1]!, mode: m[2] as Root['mode'] } : { path: value, mode: 'read' };
}
