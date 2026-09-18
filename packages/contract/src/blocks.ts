import { z } from 'zod';

/**
 * Canonical message blocks, modeled on the Anthropic Messages API (ADR 0004).
 * Adapters translate to and from each provider's format.
 */

export const MediaSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
]);
export type MediaSource = z.infer<typeof MediaSource>;

export const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
export type TextBlock = z.infer<typeof TextBlock>;

export const ImageBlock = z.object({ type: z.literal('image'), source: MediaSource });
export type ImageBlock = z.infer<typeof ImageBlock>;

export const DocumentBlock = z.object({
  type: z.literal('document'),
  name: z.string(),
  mediaType: z.string(),
  source: MediaSource,
});
export type DocumentBlock = z.infer<typeof DocumentBlock>;

export const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  toolServerId: z.string(),
  name: z.string(),
  input: z.unknown(),
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
