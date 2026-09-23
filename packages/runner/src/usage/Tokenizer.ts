import { isTextMediaType, type Block, type DocumentBlock, type Message } from '@comitiva/contract';

/**
 * A rough token count, used only when a provider reports none (a cancelled
 * run, a server that ignores `include_usage`). Every model here uses a
 * different BPE vocabulary, so no local count can be exact; a real tokenizer
 * would add megabytes of rank tables and still be wrong for two of the four
 * API providers. This aims for the right order of magnitude and never
 * pretends otherwise: everything it feeds is flagged `estimated: true`.
 *
 * The shape of the estimate:
 * - Latin-script text splits on whitespace, and a word costs one token per
 *   four characters (long words break into several BPE pieces).
 * - Punctuation and symbols are a token each: they rarely merge.
 * - CJK, Hangul and Kana are about one token per character.
 * - Images and binary documents are charged a flat rate, being nowhere near
 *   free. A text document with its bytes at hand is counted as text.
 */

/** A conservative middle between Anthropic's and Gemini's per-image counts. */
export const IMAGE_TOKENS = 1_200;

/**
 * A binary document's body is not text we can measure (a PDF is pages, not
 * characters), so it gets one flat charge, roughly a handful of pages.
 */
export const DOCUMENT_TOKENS = 3_000;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ｦ-ﾟ]/u;
const WORDISH = /[\p{L}\p{N}_]/u;

/** Tokens in a piece of text. Empty text is zero, never one. */
export function countText(text: string): number {
  let tokens = 0;
  let wordChars = 0;
  const flush = (): void => {
    if (wordChars > 0) tokens += Math.ceil(wordChars / 4);
    wordChars = 0;
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flush();
      tokens += 1;
    } else if (WORDISH.test(ch)) {
      wordChars += 1;
    } else if (ch === ' ' || ch === '\t') {
      flush();
    } else {
      // Newlines, punctuation, emoji: their own token.
      flush();
      tokens += 1;
    }
  }
  flush();
  return tokens;
}

/** Tokens in one block, including the JSON of tool calls and their results. */
export function countBlock(block: Block): number {
  switch (block.type) {
    case 'text':
      return countText(block.text);
    case 'image':
      return IMAGE_TOKENS;
    case 'document':
      return countText(block.name) + documentTokens(block);
    case 'tool_use':
      return countText(block.name) + countText(JSON.stringify(block.input ?? {}));
    case 'tool_result':
      return block.content.reduce(
        (n, part) => n + (part.type === 'text' ? countText(part.text) : IMAGE_TOKENS),
        0,
      );
  }
}

function documentTokens(block: DocumentBlock): number {
  if (block.source.kind === 'base64' && isTextMediaType(block.mediaType)) {
    return countText(Buffer.from(block.source.data, 'base64').toString('utf8'));
  }
  return DOCUMENT_TOKENS;
}

/** Tokens in a list of blocks. */
export function countBlocks(blocks: readonly Block[]): number {
  return blocks.reduce((n, b) => n + countBlock(b), 0);
}

/** Tokens in a prompt: the system prompt plus every message. */
export function countPrompt(system: string, messages: readonly Message[]): number {
  return countText(system) + messages.reduce((n, m) => n + countBlocks(m.content), 0);
}
