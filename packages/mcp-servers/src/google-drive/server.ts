import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DriveApi, DriveError, MIME, quote, type DriveFile } from './DriveApi.js';

export interface GoogleDriveServerOptions {
  /** An OAuth access token with the `drive` scope. The shell refreshes it and restarts the server. */
  accessToken: string;
  /** Drive API origin (tests point it at a fake). */
  apiBaseUrl?: string | undefined;
  /**
   * The MCP client (Comitiva's runner) asks the user before every write call,
   * so the server may register write tools. Without it the server is
   * read-only, like the filesystem server (docs/tools.md).
   */
  gatedByClient: boolean;
  version?: string;
  fetch?: typeof fetch | undefined;
}

const TEXT_CAP = 1024 * 1024;
const IMAGE_CAP = 5 * 1024 * 1024;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const TYPES = {
  doc: MIME.doc,
  sheet: MIME.sheet,
  slides: MIME.slides,
  folder: MIME.folder,
  pdf: 'application/pdf',
} as const;

/** How `read` turns a Google Workspace file into text. */
const EXPORTS: Record<string, string> = {
  [MIME.doc]: 'text/markdown',
  [MIME.sheet]: 'text/csv',
  [MIME.slides]: 'text/plain',
};

/** How `create` and `update` upload content for each kind. */
const UPLOADS: Record<string, string> = {
  [MIME.doc]: 'text/markdown; charset=UTF-8',
  [MIME.sheet]: 'text/csv; charset=UTF-8',
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The built-in `google-drive` MCP server. It gets an access token from the
 * shell (env, never from disk) and calls Drive REST v3. Errors come back as
 * tool results with the stable code first (`not_found: …`).
 */
export function createGoogleDriveServer(opts: GoogleDriveServerOptions): McpServer {
  const api = new DriveApi({
    token: opts.accessToken,
    baseUrl: opts.apiBaseUrl,
    fetch: opts.fetch,
  });
  const server = new McpServer(
    { name: 'comitiva-google-drive', version: opts.version ?? '0.1.0' },
    {
      instructions:
        "The user's Google Drive. Find files with search, then read them by id. " +
        'Google Docs read as Markdown, Sheets as CSV (first sheet), Slides as plain text.',
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search Drive',
      description:
        'Finds files in Google Drive by text (in the name or the content), type and folder. ' +
        'Without a query, lists the most recently modified files. Returns ids to use with read.',
      inputSchema: {
        query: z.string().optional().describe('Words to look for in names and content'),
        type: z
          .enum(['doc', 'sheet', 'slides', 'folder', 'pdf', 'any'])
          .optional()
          .describe('Only this kind of file (default any)'),
        folderId: z.string().optional().describe('Only files directly inside this folder'),
        pageSize: z.number().int().min(1).max(50).optional().describe('Default 20'),
        pageToken: z.string().optional().describe('From a previous search, for the next page'),
      },
      annotations: READ,
    },
    (args) => run(() => search(api, args)),
  );

  server.registerTool(
    'read',
    {
      title: 'Read file',
      description:
        'Reads a Drive file by id: Google Docs as Markdown, Sheets as CSV (first sheet only), ' +
        'Slides as plain text, text files as they are (up to 1 MB) and images (up to 5 MB).',
      inputSchema: { fileId: z.string().min(1) },
      annotations: READ,
    },
    ({ fileId }) => run(() => read(api, fileId)),
  );

  if (opts.gatedByClient) {
    server.registerTool(
      'create',
      {
        title: 'Create file',
        description:
          'Creates a Google Doc (content in Markdown), a Google Sheet (content in CSV), a plain ' +
          'file, or a folder. Without parentId it goes to the top of My Drive.',
        inputSchema: {
          name: z.string().min(1),
          kind: z.enum(['doc', 'sheet', 'text', 'folder']),
          content: z.string().optional().describe('Markdown for doc, CSV for sheet, text for text'),
          mimeType: z
            .string()
            .optional()
            .describe('For kind text: the file type, e.g. text/markdown (default text/plain)'),
          parentId: z.string().optional().describe('The folder to create it in'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      (args) => run(() => create(api, args)),
    );

    server.registerTool(
      'update',
      {
        title: 'Update file',
        description:
          "Replaces a file's content (Markdown for Google Docs, CSV for Sheets, text for text " +
          'files) and/or renames it. The old content is replaced, not merged.',
        inputSchema: {
          fileId: z.string().min(1),
          content: z.string().optional(),
          name: z.string().min(1).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => run(() => update(api, args)),
    );

    server.registerTool(
      'move',
      {
        title: 'Move file',
        description:
          'Moves a file or folder into another folder (use "root" for the top of My Drive), ' +
          'optionally renaming it.',
        inputSchema: {
          fileId: z.string().min(1),
          toFolderId: z.string().min(1),
          name: z.string().min(1).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => run(() => move(api, args)),
    );
  }
  return server;
}

type Content = CallToolResult['content'];

async function search(
  api: DriveApi,
  args: {
    query?: string | undefined;
    type?: keyof typeof TYPES | 'any' | undefined;
    folderId?: string | undefined;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  },
): Promise<Content> {
  const clauses = ['trashed = false'];
  const text = args.query?.trim();
  if (text) clauses.push(`(name contains ${quote(text)} or fullText contains ${quote(text)})`);
  if (args.type && args.type !== 'any') clauses.push(`mimeType = ${quote(TYPES[args.type])}`);
  if (args.folderId) clauses.push(`${quote(args.folderId)} in parents`);
  const res = await api.list({
    q: clauses.join(' and '),
    pageSize: args.pageSize ?? 20,
    pageToken: args.pageToken,
    // Drive refuses orderBy with fullText queries.
    orderBy: text ? undefined : 'modifiedTime desc',
  });
  if (res.files.length === 0) return [{ type: 'text', text: 'No files found.' }];
  const lines = res.files.map((f) => `- ${describe(f)}`);
  if (res.nextPageToken) lines.push('', `More results: pageToken ${res.nextPageToken}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

async function read(api: DriveApi, fileId: string): Promise<Content> {
  const file = await api.get(fileId);
  const header = `${describe(file)}\n\n`;
  if (file.mimeType === MIME.folder) {
    throw new DriveError('invalid_request', `${file.name} is a folder: search with its folderId`);
  }
  const exportAs = EXPORTS[file.mimeType];
  if (exportAs) {
    const { bytes, truncated } = await api.export(file.id, exportAs, TEXT_CAP);
    return [{ type: 'text', text: header + bytes.toString('utf8') + truncatedNote(truncated) }];
  }
  if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new DriveError('unsupported_content', `${file.name} (${file.mimeType}) cannot be read`);
  }
  const size = Number(file.size ?? 0);
  if (IMAGE_TYPES.has(file.mimeType)) {
    if (size > IMAGE_CAP) {
      throw new DriveError('unsupported_content', `${file.name} is larger than 5 MB`);
    }
    const { bytes } = await api.download(file.id, IMAGE_CAP, false);
    return [
      { type: 'text', text: header.trimEnd() },
      { type: 'image', data: bytes.toString('base64'), mimeType: file.mimeType },
    ];
  }
  if (!isTextLike(file.mimeType)) {
    throw new DriveError(
      'unsupported_content',
      `${file.name} is ${file.mimeType}, which cannot be read as text`,
    );
  }
  const { bytes, truncated } = await api.download(file.id, TEXT_CAP, size > TEXT_CAP);
  return [{ type: 'text', text: header + bytes.toString('utf8') + truncatedNote(truncated) }];
}

async function create(
  api: DriveApi,
  args: {
    name: string;
    kind: 'doc' | 'sheet' | 'text' | 'folder';
    content?: string | undefined;
    mimeType?: string | undefined;
    parentId?: string | undefined;
  },
): Promise<Content> {
  const parents = args.parentId ? [args.parentId] : undefined;
  let file: DriveFile;
  if (args.kind === 'folder') {
    if (args.content) throw new DriveError('invalid_request', 'a folder has no content');
    file = await api.create({ name: args.name, mimeType: MIME.folder, parents });
  } else if (args.kind === 'text') {
    const mimeType = args.mimeType ?? 'text/plain';
    if (!isTextLike(mimeType)) {
      throw new DriveError('invalid_request', `${mimeType} is not a text type`);
    }
    file = await api.create(
      { name: args.name, mimeType, parents },
      { contentType: `${mimeType}; charset=UTF-8`, body: args.content ?? '' },
    );
  } else {
    const mimeType = TYPES[args.kind];
    file = await api.create(
      { name: args.name, mimeType, parents },
      { contentType: UPLOADS[mimeType]!, body: args.content ?? '' },
    );
  }
  return [{ type: 'text', text: `Created ${describe(file)}` }];
}

async function update(
  api: DriveApi,
  args: { fileId: string; content?: string | undefined; name?: string | undefined },
): Promise<Content> {
  if (args.content === undefined && args.name === undefined) {
    throw new DriveError('invalid_request', 'give content, name or both');
  }
  let file: DriveFile;
  if (args.content === undefined) {
    file = await api.patch(args.fileId, { name: args.name });
  } else {
    const current = await api.get(args.fileId);
    const contentType =
      UPLOADS[current.mimeType] ??
      (isTextLike(current.mimeType) ? `${current.mimeType}; charset=UTF-8` : undefined);
    if (!contentType) {
      throw new DriveError(
        'invalid_request',
        `the content of ${current.name} (${current.mimeType}) cannot be replaced with text`,
      );
    }
    file = await api.updateContent(
      current.id,
      { contentType, body: args.content },
      args.name === undefined ? {} : { name: args.name },
    );
  }
  return [{ type: 'text', text: `Updated ${describe(file)}` }];
}

async function move(
  api: DriveApi,
  args: { fileId: string; toFolderId: string; name?: string | undefined },
): Promise<Content> {
  const current = await api.get(args.fileId);
  const remove = (current.parents ?? []).filter((p) => p !== args.toFolderId);
  const file = await api.patch(current.id, args.name === undefined ? {} : { name: args.name }, {
    add: args.toFolderId,
    remove,
  });
  return [{ type: 'text', text: `Moved ${describe(file)}` }];
}

function describe(f: DriveFile): string {
  const parts = [`"${f.name}"`, `id ${f.id}`, kindOf(f.mimeType)];
  if (f.modifiedTime) parts.push(`modified ${f.modifiedTime}`);
  if (f.parents?.length) parts.push(`in folder ${f.parents.join(', ')}`);
  if (f.webViewLink) parts.push(f.webViewLink);
  return parts.join(' · ');
}

const LABELS: Record<string, string> = {
  [MIME.doc]: 'Google Doc',
  [MIME.sheet]: 'Google Sheet',
  [MIME.slides]: 'Google Slides',
  [MIME.folder]: 'folder',
};

function kindOf(mimeType: string): string {
  return LABELS[mimeType] ?? mimeType;
}

function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    /^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|csv|x-ndjson)$/.test(mimeType) ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}

function truncatedNote(truncated: boolean): string {
  return truncated ? '\n\n[truncated at 1 MB]' : '';
}

async function run(fn: () => Promise<Content>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (err) {
    const code = err instanceof DriveError ? err.code : 'tool_failed';
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
  }
}

/** `--gated-by-client` only; the token comes from the environment. */
export function parseArgs(argv: readonly string[]): { gatedByClient: boolean } {
  let gatedByClient = false;
  for (const arg of argv) {
    if (arg === '--gated-by-client') gatedByClient = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { gatedByClient };
}
