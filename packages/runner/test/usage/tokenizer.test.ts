import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TOKENS,
  IMAGE_TOKENS,
  countBlocks,
  countPrompt,
  countText,
} from '../../src/usage/Tokenizer.js';

/**
 * The estimate only has to land in the right neighbourhood. These bounds come
 * from counting the same samples with Anthropic's and OpenAI's tokenizers;
 * anything inside them is close enough for a number the UI labels estimated.
 */
const between = (value: number, low: number, high: number): void => {
  expect(value).toBeGreaterThanOrEqual(low);
  expect(value).toBeLessThanOrEqual(high);
};

describe('countText', () => {
  it('counts nothing in nothing', () => {
    expect(countText('')).toBe(0);
    expect(countText('   ')).toBe(0);
  });

  it('is close to a real tokenizer on English prose', () => {
    // 9 words, no punctuation but the full stop. Real tokenizers: 10-12.
    between(countText('The quick brown fox jumps over the lazy dog.'), 8, 14);
  });

  it('charges punctuation-heavy code more than its word count', () => {
    const code = 'const x = foo(bar, baz);';
    expect(countText(code)).toBeGreaterThan(code.split(' ').length);
    between(countText(code), 8, 16);
  });

  it('counts CJK about one token per character', () => {
    between(countText('今日は良い天気です'), 7, 11);
  });

  it('gives an emoji its own token and does not crash on surrogates', () => {
    expect(countText('🙂')).toBe(1);
    expect(countText('ok 🙂')).toBe(2);
  });

  it('grows with length rather than with word count alone', () => {
    expect(countText('antidisestablishmentarianism')).toBeGreaterThan(1);
  });
});

describe('countBlocks', () => {
  it('counts the JSON of a tool call, not just its name', () => {
    const withArgs = countBlocks([
      {
        type: 'tool_use',
        id: 't1',
        toolServerId: 'filesystem',
        name: 'read_file',
        input: { path: '/home/oscar/notes.txt', startLine: 1, endLine: 400 },
      },
    ]);
    const bare = countBlocks([
      { type: 'tool_use', id: 't1', toolServerId: 'filesystem', name: 'read_file', input: {} },
    ]);
    expect(withArgs).toBeGreaterThan(bare + 5);
  });

  it('counts a tool result, which is where the tokens really are', () => {
    const result = countBlocks([
      {
        type: 'tool_result',
        toolUseId: 't1',
        content: [{ type: 'text', text: 'line\n'.repeat(200) }],
        isError: false,
      },
    ]);
    between(result, 300, 600);
  });

  it('charges images and documents a flat rate instead of zero', () => {
    expect(
      countBlocks([
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'x' } },
      ]),
    ).toBe(IMAGE_TOKENS);
    expect(
      countBlocks([
        {
          type: 'document',
          name: 'report.pdf',
          mediaType: 'application/pdf',
          source: { kind: 'file', path: '/tmp/report.pdf' },
        },
      ]),
    ).toBeGreaterThan(DOCUMENT_TOKENS);
  });
});

describe('countPrompt', () => {
  it('includes the system prompt and every message', () => {
    const messages = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello there' }],
        status: 'complete' as const,
        seq: 1,
        error: null,
        createdAt: '2026-09-22T00:00:00.000Z',
      },
    ];
    expect(countPrompt('You are helpful.', messages)).toBe(
      countText('You are helpful.') + countText('hello there'),
    );
  });
});
