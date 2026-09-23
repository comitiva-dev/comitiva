import { z } from 'zod';

/**
 * Canonical message blocks, modeled on the Anthropic Messages API (ADR 0004).
 * Adapters translate to and from each provider's format.
 */

export const MediaSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  /**
   * A file the shell stores (attachments, ADR 0012). `path` is relative to the
   * shell's attachment store, never absolute. The shell resolves it to base64
   * before a run: the runner never reads a file source.
   */
  z.object({ kind: z.literal('file'), path: z.string(), mediaType: z.string().optional() }),
]);
export type MediaSource = z.infer<typeof MediaSource>;

export const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
export type TextBlock = z.infer<typeof TextBlock>;

export const ImageBlock = z.object({
  type: z.literal('image'),
  source: MediaSource,
  /** File name, when the image was attached by the user. */
  name: z.string().optional(),
});
export type ImageBlock = z.infer<typeof ImageBlock>;

export const DocumentBlock = z.object({
  type: z.literal('document'),
  name: z.string(),
  mediaType: z.string(),
  source: MediaSource,
});
export type DocumentBlock = z.infer<typeof DocumentBlock>;

/**
 * What a user can attach (ADR 0012): images, and text files, which travel as
 * `document` blocks. Limits are per file; a message takes at most `perMessage`.
 */
export const ATTACHMENT_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  textBytes: 1024 * 1024,
  perMessage: 10,
} as const;

export const ATTACHMENT_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** Text files attach as documents. `text/*` is accepted too; these are the non-`text/` ones. */
export const TEXT_DOCUMENT_TYPES = [
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
  'application/javascript',
  'application/typescript',
  'application/sql',
] as const;

/** Whether a document's media type is text (sent as text to every provider). */
export function isTextMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0]!.trim().toLowerCase();
  return base.startsWith('text/') || (TEXT_DOCUMENT_TYPES as readonly string[]).includes(base);
}

export const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  toolServerId: z.string(),
  name: z.string(),
  input: z.unknown(),
  /**
   * Opaque provider data that must be sent back with the call in later turns
   * (Gemini's thought signature). Only the adapter that set it reads it.
   */
  signature: z.string().optional(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;

/** Content allowed inside a tool result (same restriction as the Anthropic API). */
export const ToolResultContentBlock = z.discriminatedUnion('type', [
  TextBlock,
  ImageBlock,
  DocumentBlock,
]);
export type ToolResultContentBlock = z.infer<typeof ToolResultContentBlock>;

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.array(ToolResultContentBlock),
  isError: z.boolean(),
  durationMs: z.number().nonnegative().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

export const Block = z.discriminatedUnion('type', [
  TextBlock,
  ImageBlock,
  DocumentBlock,
  ToolUseBlock,
  ToolResultBlock,
]);
export type Block = z.infer<typeof Block>;

/**
 * Appends streamed text to a message's content: extends the last block when
 * it is text, else starts a new text block (text after a tool block). Every
 * shell applies deltas with this same rule, so snapshots and streams agree.
 * Returns a new array; blocks are not mutated.
 */
export function appendText(content: readonly Block[], text: string): Block[] {
  const last = content.at(-1);
  if (last?.type === 'text')
    return [...content.slice(0, -1), { type: 'text', text: last.text + text }];
  return [...content, { type: 'text', text }];
}
