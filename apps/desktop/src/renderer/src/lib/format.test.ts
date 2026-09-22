import { describe, expect, it } from 'vitest';
import { compactTokens, dayLabel, duration, money, share, tokens } from './format';

describe('money', () => {
  it('shows ordinary amounts in cents', () => {
    expect(money(12.5, 'en')).toBe('$12.50');
  });

  it('keeps a fraction of a cent visible instead of rounding it away', () => {
    // A single short run really does cost this much; $0.00 would read as free.
    expect(money(0.000042, 'en')).toBe('$0.000042');
  });

  it('shows exactly nothing as $0.00, because a local model is free', () => {
    expect(money(0, 'en')).toBe('$0.00');
  });

  it('follows the UI language', () => {
    expect(money(1234.5, 'pt-BR')).toContain('1.234,50');
  });
});

describe('tokens', () => {
  it('groups digits in the UI language and never shows a fraction', () => {
    expect(tokens(1234567, 'en')).toBe('1,234,567');
    expect(tokens(1234567, 'pt-BR')).toBe('1.234.567');
  });

  it('compacts big counts for tight places', () => {
    expect(compactTokens(1_200_000, 'en')).toBe('1.2M');
    expect(compactTokens(12_300, 'en')).toBe('12.3K');
  });
});

describe('dayLabel', () => {
  it('reads a bucket as the local day it already is, without shifting it', () => {
    // The bucket is built on the viewer's calendar in SQL; re-interpreting it
    // in their zone here would move it by a day.
    expect(dayLabel('2026-09-10', 'en')).toBe('Sep 10');
  });

  it('leaves anything that is not a day alone', () => {
    expect(dayLabel('', 'en')).toBe('');
  });
});

describe('duration', () => {
  it('switches from milliseconds to seconds at a second', () => {
    expect(duration(340, 'en')).toBe('340 ms');
    expect(duration(1234, 'en')).toBe('1.2 s');
  });
});

describe('share', () => {
  it('is zero rather than NaN when there is no total', () => {
    expect(share(0, 0, 'en')).toBe('0%');
  });

  it('keeps a decimal for small shares so they are not all 0%', () => {
    expect(share(1, 1000, 'en')).toBe('0.1%');
    expect(share(1, 2, 'en')).toBe('50%');
  });
});
