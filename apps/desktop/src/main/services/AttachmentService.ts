import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { ulid } from 'ulid';
import {
  AppError,
  ATTACHMENT_LIMITS,
  isTextMediaType,
  type AttachmentBlock,
  type AttachmentInput,
  type Block,
  type Message,
} from '@comitiva/contract';

/** A stored attachment's name: a ULID and a short extension. Nothing else is ever served. */
const STORED_NAME = /^[0-9A-HJKMNP-TV-Z]{26}\.[a-z0-9]{1,8}$/;

export function isStoredName(name: string): boolean {
  return STORED_NAME.test(name);
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Extensions that are text whatever the OS said the type was. */
const TEXT_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.php': 'text/x-php',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.log': 'text/plain',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
  '.tex': 'text/x-tex',
};

/** Sniffs an image type from its first bytes; the declared type is not trusted. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Whether bytes are UTF-8 text: valid encoding and no NUL. */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const MB = 1024 * 1024;
const CACHE_BYTES = 64 * MB;

/**
 * Files attached in the composer (ADR 0012). They are stored under
 * `<userData>/attachments` as `<ulid><ext>` and referenced by file blocks
 * whose path is that name. Before a run the shell resolves them to base64,
 * so the runner never reads the disk on the user's behalf.
 */
export class AttachmentService {
  private readonly cache = new Map<string, string>();
  private cacheBytes = 0;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks, stores and returns the block. Images are sniffed; text must be UTF-8. */
  async add(input: AttachmentInput): Promise<AttachmentBlock> {
    const bytes = Buffer.from(input.dataBase64, 'base64');
    const declared = input.mediaType.split(';')[0]!.trim().toLowerCase();
    const ext = extname(input.name).toLowerCase();

    const image = sniffImage(bytes);
    if (image) {
      if (bytes.length > ATTACHMENT_LIMITS.imageBytes) {
        throw tooLarge(input.name, ATTACHMENT_LIMITS.imageBytes);
      }
      const path = await this.store(bytes, IMAGE_EXT[image]!);
      return {
        type: 'image',
        name: input.name,
        source: { kind: 'file', path, mediaType: image },
      };
    }
    if (declared.startsWith('image/')) {
      throw new AppError(
        'unsupported_attachment',
        `${input.name} is not a PNG, JPEG, GIF or WebP image`,
      );
    }

    const textType = isTextMediaType(declared) ? declared : TEXT_EXT[ext];
    const looksText =
      textType !== undefined || declared === '' || declared === 'application/octet-stream';
    if (!looksText || !isUtf8Text(bytes)) {
      throw new AppError('unsupported_attachment', `${input.name} is not an image or a text file`);
    }
    if (bytes.length > ATTACHMENT_LIMITS.textBytes) {
      throw tooLarge(input.name, ATTACHMENT_LIMITS.textBytes);
    }
    const mediaType = textType ?? 'text/plain';
    const path = await this.store(bytes, /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.txt');
    return {
      type: 'document',
      name: input.name,
      mediaType,
      source: { kind: 'file', path, mediaType },
    };
  }

  /**
   * Messages with every file source replaced by base64, for a run. A file
   * that is gone becomes a text note: the turn still runs.
   */
  resolve(messages: readonly Message[]): Message[] {
    return messages.map((m) =>
      m.content.some(isFileBlock)
        ? { ...m, content: m.content.map((b) => this.resolveBlock(b)) }
        : m,
    );
  }

  /** The absolute path of a stored attachment, or null when the name is not one or it escapes. */
  locate(name: string): string | null {
    if (!isStoredName(name)) return null;
    try {
      const root = realpathSync(this.dir);
      const real = realpathSync(join(this.dir, name));
      return real.startsWith(root + sep) ? real : null;
    } catch {
      return null;
    }
  }

  /** Deletes the given attachments (an agent's, when it is deleted). */
  async remove(names: Iterable<string>): Promise<void> {
    for (const name of names) {
      if (!isStoredName(name)) continue;
      this.forget(name);
      await unlink(join(this.dir, name)).catch(() => {});
    }
  }

  /**
   * Deletes files no message references that are older than `graceMs`:
   * attachments picked for a draft that was never sent, and temp files.
   */
  async sweep(referenced: ReadonlySet<string>, graceMs = 24 * 60 * 60 * 1000): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      if (referenced.has(name)) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || this.now() - info.mtimeMs < graceMs) continue;
      await unlink(path).catch(() => {});
      this.forget(name);
      removed += 1;
    }
    return removed;
  }

  private async store(bytes: Buffer, ext: string): Promise<string> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${ulid()}${ext}`;
    const tmp = join(this.dir, `.${name}.tmp`);
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
    return name;
  }

  private resolveBlock(block: Block): Block {
    if (!isFileBlock(block) || block.source.kind !== 'file') return block;
    const data = this.read(block.source.path);
    const label = block.type === 'document' ? block.name : (block.name ?? 'image');
    if (data === null) return { type: 'text', text: `[Attachment "${label}" is missing]` };
    const mediaType =
      block.source.mediaType ?? (block.type === 'document' ? block.mediaType : 'image/png');
    return { ...block, source: { kind: 'base64', mediaType, data } };
  }

  /** Base64 of a stored file, cached: attachments never change once stored. */
  private read(name: string): string | null {
    const hit = this.cache.get(name);
    if (hit !== undefined) {
      this.cache.delete(name);
      this.cache.set(name, hit); // most recently used last
      return hit;
    }
    const path = this.locate(name);
    if (!path) return null;
    let data: string;
    try {
      data = readFileSync(path).toString('base64');
    } catch {
      return null;
    }
    this.cache.set(name, data);
    this.cacheBytes += data.length;
    for (const [key, value] of this.cache) {
      if (this.cacheBytes <= CACHE_BYTES) break;
      this.cache.delete(key);
      this.cacheBytes -= value.length;
    }
    return data;
  }

  private forget(name: string): void {
    const hit = this.cache.get(name);
    if (hit === undefined) return;
    this.cache.delete(name);
    this.cacheBytes -= hit.length;
  }
}

function isFileBlock(block: Block): block is Extract<Block, { type: 'image' | 'document' }> {
  return (block.type === 'image' || block.type === 'document') && block.source.kind === 'file';
}

/** Names of the stored attachments a message's blocks refer to. */
export function attachmentNames(content: readonly Block[]): string[] {
  return content.flatMap((b) =>
    (b.type === 'image' || b.type === 'document') && b.source.kind === 'file'
      ? [b.source.path]
      : [],
  );
}

function tooLarge(name: string, limit: number): AppError {
  return new AppError(
    'attachment_too_large',
    `${name} is larger than ${Math.round(limit / MB)} MB`,
  );
}
