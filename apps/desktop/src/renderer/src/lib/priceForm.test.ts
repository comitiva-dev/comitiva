import { describe, expect, it } from 'vitest';
import { parsePrices } from '../components/Usage/PriceOverrides';

const form = (over: Partial<Parameters<typeof parsePrices>[0]> = {}) => ({
  inputPer1M: '3',
  outputPer1M: '15',
  cacheReadPer1M: '',
  cacheWritePer1M: '',
  ...over,
});

describe('parsePrices', () => {
  it('reads the two required prices and leaves the cache ones unset', () => {
    expect(parsePrices(form())).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: null,
      cacheWritePer1M: null,
    });
  });

  it('accepts a decimal comma, which half the world types', () => {
    expect(parsePrices(form({ inputPer1M: '0,25' }))?.inputPer1M).toBe(0.25);
  });

  it('accepts zero, because a local model really is free', () => {
    expect(parsePrices(form({ inputPer1M: '0', outputPer1M: '0' }))).toMatchObject({
      inputPer1M: 0,
    });
  });

  it('refuses a missing, negative or non-numeric required price', () => {
    expect(parsePrices(form({ inputPer1M: '' }))).toBeNull();
    expect(parsePrices(form({ outputPer1M: '  ' }))).toBeNull();
    expect(parsePrices(form({ inputPer1M: '-1' }))).toBeNull();
    expect(parsePrices(form({ outputPer1M: 'free' }))).toBeNull();
  });

  it('refuses a cache price that was typed but is not a number', () => {
    expect(parsePrices(form({ cacheReadPer1M: 'x' }))).toBeNull();
    expect(parsePrices(form({ cacheWritePer1M: '0.3' }))?.cacheWritePer1M).toBe(0.3);
  });
});
