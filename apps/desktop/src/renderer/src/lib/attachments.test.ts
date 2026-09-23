import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@comitiva/contract';
import {
  acceptsImages,
  canSendDraft,
  draftContent,
  formatSize,
  precheck,
  room,
  type DraftAttachment,
} from './attachments';

const ready = (id: string): DraftAttachment => ({
  id,
  name: `${id}.md`,
  size: 10,
  isImage: false,
  status: 'ready',
  block: {
    type: 'document',
    name: `${id}.md`,
    mediaType: 'text/markdown',
    source: { kind: 'file', path: `${id}.md` },
  },
});

describe('draft attachments', () => {
  it('checks sizes by kind before reading the file', () => {
    expect(precheck({ type: 'image/png', size: ATTACHMENT_LIMITS.imageBytes })).toBeNull();
    expect(precheck({ type: 'image/png', size: ATTACHMENT_LIMITS.imageBytes + 1 })).toBe(
      'attachment_too_large',
    );
    expect(precheck({ type: 'text/plain', size: ATTACHMENT_LIMITS.textBytes + 1 })).toBe(
      'attachment_too_large',
    );
  });

  it('sends text, files or both, but never while a file uploads', () => {
    expect(canSendDraft('  ', [])).toBe(false);
    expect(canSendDraft('hi', [])).toBe(true);
    expect(canSendDraft('', [ready('a')])).toBe(true);
    expect(canSendDraft('hi', [{ ...ready('b'), status: 'uploading' }])).toBe(false);
    expect(canSendDraft('', [{ ...ready('c'), status: 'failed' }])).toBe(false);
  });

  it('builds the content from the text and the stored files only', () => {
    expect(draftContent(' hi ', [ready('a'), { ...ready('b'), status: 'failed' }])).toEqual([
      { type: 'text', text: 'hi' },
      ready('a').block,
    ]);
    expect(draftContent('', [ready('a')])).toEqual([ready('a').block]);
  });

  it('counts the room left, ignoring refused files', () => {
    const list = Array.from({ length: 9 }, (_, i) => ready(String(i)));
    expect(room(list)).toBe(1);
    expect(room([...list, { ...ready('x'), status: 'failed' }])).toBe(1);
    expect(room([...list, ready('y'), ready('z')])).toBe(0);
  });

  it('knows which providers take images', () => {
    expect(acceptsImages('anthropic')).toBe(true);
    expect(acceptsImages('ollama')).toBe(true);
    expect(acceptsImages('claude-code')).toBe(false);
    expect(acceptsImages('codex')).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatSize(512, 'en')).toBe('512 B');
    expect(formatSize(1536, 'en')).toBe('1.5 KB');
    expect(formatSize(5 * 1024 * 1024, 'pt-BR')).toBe('5 MB');
  });
});
