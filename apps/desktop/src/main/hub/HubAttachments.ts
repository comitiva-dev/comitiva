import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Block, Message } from '@comitiva/contract';
import type { HubClient } from './HubClient';

/** Hub attachment ids are ULIDs (lowercase from the hub). */
const ID = /^[0-9A-Za-z]{26}$/;

/**
 * Attachments of workspace messages live on the hub; a file block's path is
 * the attachment id. This cache downloads them once, into
 * `<userData>/hub-cache`, for runs (resolved to base64 like local ones) and
 * for the window (the `comitiva-hub-attachment://` protocol, so the token
 * never reaches the renderer).
 */
export class HubAttachments {
  constructor(
    private readonly dir: string,
    private readonly client: () => HubClient,
  ) {}

  async get(id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    if (!ID.test(id)) return null;
    const path = join(this.dir, id);
    try {
      const [bytes, contentType] = await Promise.all([
        readFile(path),
        readFile(`${path}.type`, 'utf8'),
      ]);
      return { bytes, contentType };
    } catch {
      // not cached yet
    }
    const file = await this.client().download(`/api/v1/attachments/${id}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, file.bytes, { mode: 0o600 });
    await writeFile(`${path}.type`, file.contentType, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return file;
  }

  /** Messages with every file source replaced by base64; a file that cannot be had becomes a note. */
  async resolve(messages: readonly Message[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const m of messages) {
      const content: Block[] = [];
      for (const b of m.content) content.push(await this.resolveBlock(b));
      out.push({ ...m, content });
    }
    return out;
  }

  private async resolveBlock(block: Block): Promise<Block> {
    if ((block.type !== 'image' && block.type !== 'document') || block.source.kind !== 'file') {
      return block;
    }
    const label = block.type === 'document' ? block.name : (block.name ?? 'image');
    const file = await this.get(block.source.path).catch(() => null);
    if (!file) return { type: 'text', text: `[Attachment "${label}" is missing]` };
    const mediaType =
      block.source.mediaType ?? (block.type === 'document' ? block.mediaType : file.contentType);
    return { ...block, source: { kind: 'base64', mediaType, data: file.bytes.toString('base64') } };
  }
}
