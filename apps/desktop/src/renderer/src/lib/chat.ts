import type { Block, ImageBlock, Message, ToolResultBlock, ToolUseBlock } from '@comitiva/contract';

/**
 * The conversation an agent's chat shows: the one the user picked, else the
 * most recent one. `null` means the user asked for a new conversation (or the
 * agent has none): the chat shows an empty composer that creates one on send.
 */
export function openConversation(
  picked: string | null | undefined,
  ids: readonly string[],
): string | null {
  if (picked === undefined) return ids[0] ?? null;
  return picked;
}

/** Draft key for the "new conversation" composer of an agent. */
export const newDraftKey = (agentId: string) => `new:${agentId}`;

/** What a key press in the composer does. IME composition never sends. */
export function composerKey(e: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): 'send' | null {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return null;
  return 'send';
}

/** Retry is offered on the conversation's last message, when it is a failed reply. */
export function canRetry(items: readonly Message[]): boolean {
  const last = items.at(-1);
  return last?.role === 'assistant' && last.status === 'error';
}

export type RenderPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; block: ImageBlock }
  | { kind: 'tool'; use: ToolUseBlock; result: ToolResultBlock | null }
  | { kind: 'other'; type: Block['type'] };

/**
 * A message's blocks as the chat draws them: each tool_use joined with its
 * tool_result (which may come later, or never while it runs). Results with no
 * matching use are dropped; empty text is skipped.
 */
export function renderParts(content: readonly Block[]): RenderPart[] {
  const results = new Map<string, ToolResultBlock>();
  for (const b of content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  const parts: RenderPart[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text !== '') parts.push({ kind: 'text', text: b.text });
    } else if (b.type === 'image') parts.push({ kind: 'image', block: b });
    else if (b.type === 'tool_use')
      parts.push({ kind: 'tool', use: b, result: results.get(b.id) ?? null });
    else if (b.type !== 'tool_result') parts.push({ kind: 'other', type: b.type });
  }
  return parts;
}

/** The plain text of a tool result, for the collapsed tool block. */
export function resultText(result: ToolResultBlock): string {
  return result.content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('\n')
    .trim();
}

/** Tool inputs as the tool block shows them: pretty JSON, or the string itself. */
export function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

/** `data:` URL for a base64 image; null for file sources (not readable by the renderer). */
export function imageSrc(block: ImageBlock): string | null {
  const { source } = block;
  return source.kind === 'base64' ? `data:${source.mediaType};base64,${source.data}` : null;
}

/**
 * Virtuoso's `firstItemIndex` for a list that grows at both ends: it drops by
 * one for each older message loaded above the first page, and stays put when
 * replies are appended, so the scroll position holds while paging back.
 */
export const FIRST_INDEX_BASE = 1_000_000;
export function firstItemIndex(items: readonly Message[], anchorSeq: number | null): number {
  if (anchorSeq === null) return FIRST_INDEX_BASE;
  const before = items.findIndex((m) => m.seq >= anchorSeq);
  return FIRST_INDEX_BASE - (before < 0 ? items.length : before);
}
