import {
  AppError,
  isTextMediaType,
  type Block,
  type DocumentBlock,
  type ImageBlock,
  type MediaSource,
} from '@comitiva/contract';

/**
 * Attachments (ADR 0012) as adapters send them. The shell resolves file
 * sources to base64 before a run, so a file source here is a shell bug.
 *
 * - Text documents become text for every provider: a `<document>` element
 *   around the decoded file.
 * - Images go natively to providers that take them; the others get a short
 *   note in their place, so the model knows something was attached.
 * - Other documents (a PDF to a provider without document support) get a
 *   note too, rather than failing the whole turn.
 */

export type Base64Source = Extract<MediaSource, { kind: 'base64' }>;

export type UserPart =
  { kind: 'text'; text: string } | { kind: 'image'; mediaType: string; data: string };

/** The base64 source of an attachment; file sources never reach the runner. */
export function base64Of(block: ImageBlock | DocumentBlock): Base64Source {
  if (block.source.kind !== 'base64') {
    throw new AppError(
      'invalid_request',
      `${block.type} blocks with file sources must be resolved by the shell before a run`,
    );
  }
  return block.source;
}

/** A text document as the text the model reads. */
export function documentText(block: DocumentBlock): string {
  const text = Buffer.from(base64Of(block).data, 'base64').toString('utf8');
  return `<document name="${escapeAttr(block.name)}">\n${text}\n</document>`;
}

export function imageNote(block: ImageBlock, provider: string): string {
  const name = block.name ? ` "${block.name}"` : '';
  return `[Image${name} attached but not sent: ${provider} does not accept images]`;
}

export function documentNote(block: DocumentBlock, provider: string): string {
  return `[File "${block.name}" attached but not sent: ${provider} does not accept ${block.mediaType} files]`;
}

/**
 * A user message's blocks as text and image parts. `images: false` turns
 * images into notes. Adjacent text parts are merged with a newline.
 */
export function userParts(
  blocks: readonly Block[],
  opts: { images: boolean; provider: string },
): UserPart[] {
  const parts: UserPart[] = [];
  const pushText = (text: string) => {
    const last = parts.at(-1);
    if (last?.kind === 'text') last.text = `${last.text}\n${text}`;
    else parts.push({ kind: 'text', text });
  };
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        pushText(b.text);
        break;
      case 'image':
        if (opts.images) {
          const source = base64Of(b);
          parts.push({ kind: 'image', mediaType: source.mediaType, data: source.data });
        } else pushText(imageNote(b, opts.provider));
        break;
      case 'document':
        pushText(isTextMediaType(b.mediaType) ? documentText(b) : documentNote(b, opts.provider));
        break;
      default:
        throw new AppError(
          'unsupported_content',
          `${b.type} blocks are not supported in this position by ${opts.provider}`,
        );
    }
  }
  return parts;
}

/** Blocks as plain text: attachments become text or notes. */
export function textOf(blocks: readonly Block[], provider: string): string {
  return userParts(blocks, { images: false, provider })
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
