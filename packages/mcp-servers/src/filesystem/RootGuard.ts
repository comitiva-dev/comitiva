import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type RootMode = 'read' | 'readwrite';
export interface Root {
  path: string;
  mode: RootMode;
}
export type Access = 'read' | 'write';

export type GuardErrorCode = 'outside_roots' | 'read_only_root' | 'not_found' | 'invalid_request';

/** A refused path. `code` is a stable AppError code, sent back to the model. */
export class GuardError extends Error {
  constructor(
    readonly code: GuardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

/** A root after `realpath`: what every candidate is compared against. */
export interface ResolvedRoot {
  /** As the agent configured it (shown to the model). */
  path: string;
  /** Canonical absolute path, symlinks resolved. */
  real: string;
  mode: RootMode;
}

export interface Resolved {
  /** Canonical absolute path inside `root` (symlinks resolved; may not exist yet). */
  path: string;
  root: ResolvedRoot;
  /** True when the path is the root itself (it cannot be moved or deleted). */
  isRoot: boolean;
}

/** macOS and Windows volumes are usually case-insensitive. */
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/**
 * The only way the filesystem server turns a requested path into one it
 * touches. The candidate and every root are compared after `realpath`, so
 * `..`, absolute paths and symlinks (files, directories, parents, the root
 * itself) cannot escape. A path that does not exist yet is resolved through its
 * deepest existing ancestor; a dangling symlink is refused, since writing
 * through it would land wherever it points.
 *
 * Known limit: a process that swaps a directory for a symlink between the
 * check and the operation (TOCTOU) is out of scope; roots are the user's own
 * folders.
 */
export class RootGuard {
  private constructor(readonly roots: readonly ResolvedRoot[]) {}

  /** Roots that do not exist or are not directories are dropped (and reported). */
  static async create(
    roots: readonly Root[],
    warn: (msg: string) => void = () => {},
  ): Promise<RootGuard> {
    const resolved: ResolvedRoot[] = [];
    for (const root of roots) {
      if (!isAbsolute(root.path)) {
        warn(`ignoring root ${root.path}: not an absolute path`);
        continue;
      }
      try {
        const real = await realpath(root.path);
        if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
        resolved.push({ path: root.path, real, mode: root.mode });
      } catch (err) {
        warn(`ignoring root ${root.path}: ${(err as Error).message}`);
      }
    }
    return new RootGuard(resolved);
  }

  /**
   * Resolves a path for reading or writing. Relative paths are taken from the
   * first root. Throws GuardError: `outside_roots` (outside every root, or no
   * roots), `read_only_root` (a write under a read-only root).
   */
  async resolve(requested: string, access: Access): Promise<Resolved> {
    if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0')) {
      throw new GuardError('invalid_request', 'A path is required');
    }
    const first = this.roots[0];
    if (!first) throw new GuardError('outside_roots', 'This agent has no folders to work in');
    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(first.real, requested);
    const real = await canonical(absolute);
    const root = this.rootFor(real);
    if (!root) throw new GuardError('outside_roots', `${requested} is outside the allowed folders`);
    if (access === 'write' && root.mode !== 'readwrite') {
      throw new GuardError('read_only_root', `${root.path} is read-only for this agent`);
    }
    return { path: real, root, isRoot: fold(real) === fold(root.real) };
  }

  /** The most specific root containing `real` (a read-only folder inside a read-write one wins). */
  private rootFor(real: string): ResolvedRoot | undefined {
    let best: ResolvedRoot | undefined;
    for (const root of this.roots) {
      const r = fold(root.real);
      const p = fold(real);
      const inside = p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
      if (inside && (!best || root.real.length > best.real.length)) best = root;
    }
    return best;
  }
}

/**
 * realpath for paths that may not exist yet: the deepest existing ancestor is
 * canonicalized and the missing tail appended (it contains no symlinks, since
 * it does not exist).
 */
async function canonical(absolute: string): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      // A dangling symlink exists (lstat works) but cannot be resolved.
      const isLink = await lstat(current).then(
        (s) => s.isSymbolicLink(),
        () => false,
      );
      if (isLink) throw new GuardError('outside_roots', `${current} is a broken symbolic link`);
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}
