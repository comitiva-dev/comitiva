import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { GuardError, type RootGuard } from './RootGuard.js';

/** What a tool returns: MCP content blocks (text or image). */
export type Content =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export const LIMITS = {
  /** Text files larger than this are read in slices (offset/limit in lines). */
  maxTextBytes: 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  defaultLines: 2000,
  maxListEntries: 1000,
  maxSearchResults: 200,
  /** Files larger than this are skipped by content search. */
  maxSearchFileBytes: 2 * 1024 * 1024,
  maxSearchVisited: 20_000,
};

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const text = (t: string): Content[] => [{ type: 'text', text: t }];

/** Lists a folder, or the roots themselves when no path is given. */
export async function listDir(guard: RootGuard, path: string | undefined): Promise<Content[]> {
  if (path === undefined || path === '') {
    const lines = guard.roots.map(
      (r) => `${r.real}${sep}  (${r.mode === 'readwrite' ? 'read-write' : 'read-only'})`,
    );
    return text(lines.length ? lines.join('\n') : 'No folders are available to this agent.');
  }
  const { path: dir } = await guard.resolve(path, 'read');
  const entries = await readdir(dir, { withFileTypes: true }).catch(notFound(path));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const e of entries.slice(0, LIMITS.maxListEntries)) {
    if (e.isDirectory()) lines.push(`[dir]  ${e.name}/`);
    else if (e.isSymbolicLink()) lines.push(`[link] ${e.name}`);
    else {
      const size = await lstat(join(dir, e.name)).then(
        (s) => s.size,
        () => 0,
      );
      lines.push(`[file] ${e.name}  (${formatSize(size)})`);
    }
  }
  if (entries.length > LIMITS.maxListEntries) {
    lines.push(`… ${entries.length - LIMITS.maxListEntries} more entries not shown`);
  }
  return text(`${dir}${sep}\n${lines.length ? lines.join('\n') : '(empty)'}`);
}

/** Reads a text file (optionally a slice of lines) or an image. */
export async function readTextOrImage(
  guard: RootGuard,
  path: string,
  opts: { offset?: number | undefined; limit?: number | undefined } = {},
): Promise<Content[]> {
  const { path: file } = await guard.resolve(path, 'read');
  const info = await stat(file).catch(notFound(path));
  if (info.isDirectory()) throw new GuardError('invalid_request', `${path} is a folder`);
  const mime = IMAGE_TYPES[extname(file).toLowerCase()];
  if (mime) {
    if (info.size > LIMITS.maxImageBytes) {
      throw new GuardError('invalid_request', `${path} is too large to read as an image`);
    }
    return [{ type: 'image', data: (await readFile(file)).toString('base64'), mimeType: mime }];
  }
  const buf = await readHead(file, LIMITS.maxTextBytes);
  if (looksBinary(buf)) throw new GuardError('invalid_request', `${path} is not a text file`);
  const all = buf.toString('utf8').split('\n');
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? LIMITS.defaultLines);
  const slice = all.slice(offset, offset + limit);
  const truncated = info.size > LIMITS.maxTextBytes || offset + limit < all.length;
  const note = truncated
    ? `\n\n[showing lines ${offset + 1}–${offset + slice.length}${info.size > LIMITS.maxTextBytes ? ` of the first ${formatSize(LIMITS.maxTextBytes)}` : ` of ${all.length}`}; pass offset/limit for more]`
    : '';
  return text(slice.join('\n') + note);
}

/**
 * Finds files under a folder whose name matches a glob (`*`, `?`, `**`) and,
 * when `query` is given, whose text contains it (case-insensitive). Symbolic
 * links are not followed.
 */
export async function search(
  guard: RootGuard,
  args: { path?: string | undefined; pattern?: string | undefined; query?: string | undefined },
): Promise<Content[]> {
  const starts = args.path
    ? [(await guard.resolve(args.path, 'read')).path]
    : guard.roots.map((r) => r.real);
  if (starts.length === 0) throw new GuardError('outside_roots', 'This agent has no folders');
  const matcher = globToRegExp(args.pattern?.trim() || '**');
  const needle = args.query?.toLowerCase();
  const results: string[] = [];
  let visited = 0;
  let truncated = false;

  const walk = async (base: string, dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (results.length >= LIMITS.maxSearchResults || ++visited > LIMITS.maxSearchVisited) {
        truncated = true;
        return;
      }
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(base, full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(base, full).split(sep).join('/');
      if (!matcher.test(rel) && !matcher.test(e.name)) continue;
      if (needle !== undefined) {
        const line = await findInFile(full, needle);
        if (line === null) continue;
        results.push(`${full}:${line.number}: ${line.text}`);
      } else results.push(full);
    }
  };
  for (const start of starts) {
    if (!(await stat(start).then((s) => s.isDirectory(), notFound(start)))) {
      throw new GuardError('invalid_request', `${start} is not a folder`);
    }
    await walk(start, start);
  }
  if (results.length === 0) return text('No matches.');
  return text(
    results.join('\n') + (truncated ? '\n… more results not shown; narrow the search' : ''),
  );
}

/** Creates or replaces a text file; missing parent folders are created. */
export async function writeTextFile(
  guard: RootGuard,
  path: string,
  content: string,
): Promise<Content[]> {
  const { path: file } = await guard.resolve(path, 'write');
  const existing = await lstat(file).catch(() => null);
  if (existing?.isDirectory()) throw new GuardError('invalid_request', `${path} is a folder`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return text(
    `${existing ? 'Replaced' : 'Created'} ${file} (${formatSize(Buffer.byteLength(content))})`,
  );
}

export async function createDir(guard: RootGuard, path: string): Promise<Content[]> {
  const { path: dir } = await guard.resolve(path, 'write');
  await mkdir(dir, { recursive: true });
  return text(`Folder ready: ${dir}`);
}

/** Moves or renames a file or folder; both ends must be in read-write roots. */
export async function move(
  guard: RootGuard,
  from: string,
  to: string,
  overwrite = false,
): Promise<Content[]> {
  const src = await guard.resolve(from, 'write');
  const dst = await guard.resolve(to, 'write');
  if (src.isRoot) throw new GuardError('invalid_request', 'A root folder cannot be moved');
  await lstat(src.path).catch(notFound(from));
  if (!overwrite && (await lstat(dst.path).catch(() => null))) {
    throw new GuardError('invalid_request', `${to} already exists; pass overwrite to replace it`);
  }
  await mkdir(dirname(dst.path), { recursive: true });
  await rename(src.path, dst.path);
  return text(`Moved ${src.path} → ${dst.path}`);
}

/** Deletes a file, or a folder with `recursive`. Roots cannot be deleted. */
export async function remove(
  guard: RootGuard,
  path: string,
  recursive = false,
): Promise<Content[]> {
  const target = await guard.resolve(path, 'write');
  if (target.isRoot) throw new GuardError('invalid_request', 'A root folder cannot be deleted');
  const info = await lstat(target.path).catch(notFound(path));
  if (info.isDirectory() && !recursive) {
    throw new GuardError('invalid_request', `${path} is a folder; pass recursive to delete it`);
  }
  await rm(target.path, { recursive, force: false });
  return text(`Deleted ${target.path}`);
}

// ---------------------------------------------------------------- helpers

function notFound(path: string) {
  return (err: NodeJS.ErrnoException): never => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new GuardError('not_found', `${path} does not exist`);
    }
    throw err;
  };
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function findInFile(
  file: string,
  needle: string,
): Promise<{ number: number; text: string } | null> {
  const info = await stat(file).catch(() => null);
  if (!info || info.size > LIMITS.maxSearchFileBytes) return null;
  const buf = await readFile(file).catch(() => null);
  if (!buf || looksBinary(buf)) return null;
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.toLowerCase().includes(needle))
      return { number: i + 1, text: line.trim().slice(0, 200) };
  }
  return null;
}

/** `**` crosses folders, `*` and `?` do not. Matched against root-relative paths and names. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
