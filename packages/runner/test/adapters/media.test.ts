import { describe, expect, it } from 'vitest';
import type { Block, Message } from '@comitiva/contract';
import { toProviderMessages as anthropicMessages } from '../../src/providers/api/AnthropicAdapter.js';
import { toProviderContents as googleContents } from '../../src/providers/api/GoogleAdapter.js';
import { toProviderMessages as ollamaMessages } from '../../src/providers/api/OllamaAdapter.js';
import { toProviderMessages as openaiMessages } from '../../src/providers/api/OpenAICompatibleAdapter.js';
import { buildPrompt } from '../../src/providers/cli/prompt.js';
import { userParts } from '../../src/providers/media.js';
import { countBlock, DOCUMENT_TOKENS } from '../../src/usage/Tokenizer.js';
import { userText } from '../../src/testing/index.js';

const PNG = 'iVBORw0KGgo=';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const image: Block = {
  type: 'image',
  name: 'chart.png',
  source: { kind: 'base64', mediaType: 'image/png', data: PNG },
};
const notes: Block = {
  type: 'document',
  name: 'notes.md',
  mediaType: 'text/markdown',
  source: { kind: 'base64', mediaType: 'text/markdown', data: b64('# Plan\nShip it.') },
};
const pdf: Block = {
  type: 'document',
  name: 'deck.pdf',
  mediaType: 'application/pdf',
  source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBERg==' },
};

function user(content: Block[]): Message {
  return { ...userText('c', ''), content };
}

const withAttachments = user([{ type: 'text', text: 'Look at these' }, image, notes]);

describe('userParts', () => {
  it('inlines text documents and keeps images for providers that take them', () => {
    expect(userParts(withAttachments.content, { images: true, provider: 'P' })).toEqual([
      {
        kind: 'text',
        text: 'Look at these',
      },
      { kind: 'image', mediaType: 'image/png', data: PNG },
      { kind: 'text', text: '<document name="notes.md">\n# Plan\nShip it.\n</document>' },
    ]);
  });

  it('turns images into a note when the provider does not take them', () => {
    const parts = userParts(withAttachments.content, { images: false, provider: 'Codex' });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'text' });
    const text = parts[0]!.kind === 'text' ? parts[0]!.text : '';
    expect(text).toContain(
      '[Image "chart.png" attached but not sent: Codex does not accept images]',
    );
    expect(text).toContain('<document name="notes.md">');
  });

  it('notes a binary document the provider cannot read instead of failing', () => {
    expect(userParts([pdf], { images: true, provider: 'Ollama' })).toEqual([
      {
        kind: 'text',
        text: '[File "deck.pdf" attached but not sent: Ollama does not accept application/pdf files]',
      },
    ]);
  });

  it('escapes the document name', () => {
    const [part] = userParts([{ ...notes, name: 'a"b<c.md' } as Block], {
      images: false,
      provider: 'P',
    });
    expect(part).toMatchObject({ text: expect.stringContaining('name="a&quot;b&lt;c.md"') });
  });

  it('refuses a file source: the shell resolves attachments before a run', () => {
    expect(() =>
      userParts([{ type: 'image', source: { kind: 'file', path: 'x.png' } }], {
        images: true,
        provider: 'P',
      }),
    ).toThrow(/resolved by the shell/);
  });
});

describe('attachments per provider', () => {
  it('Anthropic: native image, text document as a plain-text document', () => {
    const [m] = anthropicMessages([withAttachments]);
    expect(m!.content).toEqual([
      { type: 'text', text: 'Look at these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      {
        type: 'document',
        title: 'notes.md',
        source: { type: 'text', media_type: 'text/plain', data: '# Plan\nShip it.' },
      },
    ]);
  });

  it('Anthropic: a PDF stays a document, another binary becomes a note', () => {
    const [m] = anthropicMessages([
      user([pdf, { ...pdf, name: 'a.zip', mediaType: 'application/zip' } as Block]),
    ]);
    expect(m!.content).toEqual([
      {
        type: 'document',
        title: 'deck.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' },
      },
      { type: 'text', text: expect.stringContaining('"a.zip" attached but not sent') },
    ]);
  });

  it('OpenAI-compatible: image_url data URL; plain string when there is no image', () => {
    const out = openaiMessages('', [withAttachments]);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at these' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: 'text', text: '<document name="notes.md">\n# Plan\nShip it.\n</document>' },
      ],
    });
    expect(openaiMessages('', [user([notes])])[0]).toEqual({
      role: 'user',
      content: '<document name="notes.md">\n# Plan\nShip it.\n</document>',
    });
  });

  it('Google: inlineData parts', () => {
    const [c] = googleContents([withAttachments]);
    expect(c!.parts).toEqual([
      { text: 'Look at these' },
      { inlineData: { mimeType: 'image/png', data: PNG } },
      { text: '<document name="notes.md">\n# Plan\nShip it.\n</document>' },
    ]);
  });

  it('Ollama: the images array beside the text', () => {
    expect(ollamaMessages('', [withAttachments])[0]).toEqual({
      role: 'user',
      content: 'Look at these\n<document name="notes.md">\n# Plan\nShip it.\n</document>',
      images: [PNG],
    });
  });

  it('CLI harnesses: text documents inline, images as a note, in the new message and the replay', () => {
    const prompt = buildPrompt([withAttachments], false, 'Claude Code');
    expect(prompt).toContain('Look at these');
    expect(prompt).toContain('Claude Code does not accept images');
    expect(prompt).toContain('# Plan\nShip it.');
    const replay = buildPrompt(
      [withAttachments, { ...userText('c', 'next', 1), role: 'user' }],
      false,
      'Codex',
    );
    expect(replay).toContain('[image chart.png]');
    expect(replay).toContain('# Plan\nShip it.');
  });
});

describe('Tokenizer on attachments', () => {
  it('counts a text document by its text, a PDF at the flat rate', () => {
    expect(countBlock(notes)).toBeLessThan(20);
    expect(countBlock(pdf)).toBeGreaterThanOrEqual(DOCUMENT_TOKENS);
  });
});
