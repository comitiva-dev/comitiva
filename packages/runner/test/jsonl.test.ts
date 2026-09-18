import { describe, expect, it } from 'vitest';
import { LineSplitter, encodeLine } from '../src/util/jsonl.js';

function collect() {
  const lines: string[] = [];
  return { lines, splitter: new LineSplitter((l) => lines.push(l)) };
}

describe('LineSplitter', () => {
  it('reassembles lines split across chunks', () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":');
    splitter.push('1}\n{"b"');
    splitter.push(':2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles multi-byte characters split between chunks', () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from(encodeLine({ text: 'olá 👋' }));
    splitter.push(bytes.subarray(0, 12));
    splitter.push(bytes.subarray(12));
    expect(JSON.parse(lines[0]!)).toEqual({ text: 'olá 👋' });
  });

  it('skips blank lines, strips CR and flushes a trailing line on end', () => {
    const { lines, splitter } = collect();
    splitter.push('\n{"a":1}\r\n\n{"b":2}');
    expect(lines).toEqual(['{"a":1}']);
    splitter.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('keeps embedded newlines inside one encoded line', () => {
    expect(encodeLine({ text: 'a\nb' }).split('\n')).toHaveLength(2);
  });
});
