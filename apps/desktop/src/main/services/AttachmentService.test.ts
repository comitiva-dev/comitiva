import { mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '@comitiva/contract';
import { ATTACHMENT_LIMITS, type Message } from '@comitiva/contract';
import { AttachmentService, isStoredName, sniffImage } from './AttachmentService';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

let dir: string;
let service: AttachmentService;
const now = Date.now();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comitiva-attachments-'));
  service = new AttachmentService(join(dir, 'attachments'), () => now);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (err) {
    return (err as AppError).code;
  }
}

describe('AttachmentService.add', () => {
  it('stores an image under a ULID name, with the sniffed type', async () => {
    // Declared as JPEG, but the bytes are PNG: the bytes win.
    const block = await service.add({
      name: 'shot.jpg',
      mediaType: 'image/jpeg',
      dataBase64: b64(PNG),
    });
    expect(block).toMatchObject({
      type: 'image',
      name: 'shot.jpg',
      source: { kind: 'file', mediaType: 'image/png' },
    });
    const path = (block.source as { path: string }).path;
    expect(isStoredName(path)).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(readdirSync(join(dir, 'attachments'))).toEqual([path]);
  });

  it('stores text files as documents, typed by extension when the OS said nothing', async () => {
    const block = await service.add({
      name: 'data.csv',
      mediaType: '',
      dataBase64: b64('a,b\n1,2'),
    });
    expect(block).toMatchObject({
      type: 'document',
      name: 'data.csv',
      mediaType: 'text/csv',
      source: { kind: 'file', mediaType: 'text/csv' },
    });
    const md = await service.add({
      name: 'README',
      mediaType: 'text/markdown',
      dataBase64: b64('# Hi'),
    });
    expect(md).toMatchObject({ mediaType: 'text/markdown' });
    expect((md.source as { path: string }).path.endsWith('.txt')).toBe(true);
  });

  it('refuses binaries, fake images and invalid UTF-8', async () => {
    expect(
      await codeOf(
        service.add({
          name: 'a.zip',
          mediaType: 'application/zip',
          dataBase64: b64('PK\u0003\u0004'),
        }),
      ),
    ).toBe('unsupported_attachment');
    expect(
      await codeOf(
        service.add({ name: 'a.png', mediaType: 'image/png', dataBase64: b64('not a png') }),
      ),
    ).toBe('unsupported_attachment');
    expect(
      await codeOf(
        service.add({
          name: 'a.txt',
          mediaType: 'text/plain',
          dataBase64: b64(Buffer.from([0xc3, 0x28])),
        }),
      ),
    ).toBe('unsupported_attachment');
    expect(
      await codeOf(
        service.add({ name: 'a.txt', mediaType: 'text/plain', dataBase64: b64('a\u0000b') }),
      ),
    ).toBe('unsupported_attachment');
  });

  it('enforces the size limits', async () => {
    const bigText = Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 'a');
    expect(
      await codeOf(
        service.add({ name: 'a.txt', mediaType: 'text/plain', dataBase64: b64(bigText) }),
      ),
    ).toBe('attachment_too_large');
    const bigImage = Buffer.concat([JPEG, Buffer.alloc(ATTACHMENT_LIMITS.imageBytes)]);
    expect(
      await codeOf(
        service.add({ name: 'a.jpg', mediaType: 'image/jpeg', dataBase64: b64(bigImage) }),
      ),
    ).toBe('attachment_too_large');
  });
});

describe('AttachmentService.locate', () => {
  it('serves only stored names inside the directory', async () => {
    const block = await service.add({
      name: 'a.png',
      mediaType: 'image/png',
      dataBase64: b64(PNG),
    });
    const name = (block.source as { path: string }).path;
    expect(service.locate(name)).toBe(join(dir, 'attachments', name));
    expect(service.locate('../secrets.bin')).toBeNull();
    expect(service.locate(`../attachments/${name}`)).toBeNull();
    expect(service.locate('01JAAAAAAAAAAAAAAAAAAAAAAA.png')).toBeNull(); // missing
  });

  it('refuses a symlink that leads out of the directory', async () => {
    await service.add({ name: 'a.png', mediaType: 'image/png', dataBase64: b64(PNG) });
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    const link = '01JBBBBBBBBBBBBBBBBBBBBBBB.txt';
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'attachments', link));
    expect(service.locate(link)).toBeNull();
  });
});

describe('AttachmentService.resolve and sweep', () => {
  it('resolves file sources to base64 and leaves other messages alone', async () => {
    const block = await service.add({
      name: 'a.png',
      mediaType: 'image/png',
      dataBase64: b64(PNG),
    });
    const message = {
      id: 'm',
      content: [{ type: 'text', text: 'x' }, block],
    } as unknown as Message;
    const plain = { id: 'n', content: [{ type: 'text', text: 'y' }] } as unknown as Message;
    const [resolved, untouched] = service.resolve([message, plain]);
    expect(resolved!.content[1]).toEqual({
      type: 'image',
      name: 'a.png',
      source: { kind: 'base64', mediaType: 'image/png', data: b64(PNG) },
    });
    expect(untouched).toBe(plain);
  });

  it('deletes unreferenced files once they are old enough, and removes by name', async () => {
    const kept = await service.add({ name: 'a.png', mediaType: 'image/png', dataBase64: b64(PNG) });
    const draft = await service.add({
      name: 'b.png',
      mediaType: 'image/png',
      dataBase64: b64(PNG),
    });
    const keptName = (kept.source as { path: string }).path;
    const draftName = (draft.source as { path: string }).path;
    const referenced = new Set([keptName]);

    expect(await service.sweep(referenced)).toBe(0); // too recent
    const old = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(join(dir, 'attachments', draftName), old, old);
    utimesSync(join(dir, 'attachments', keptName), old, old);
    expect(await service.sweep(referenced)).toBe(1);
    expect(readdirSync(join(dir, 'attachments'))).toEqual([keptName]);

    await service.remove([keptName, '../nope']);
    expect(readdirSync(join(dir, 'attachments'))).toEqual([]);
  });
});

describe('sniffImage', () => {
  it('knows the four formats and nothing else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});
