import { describe, expect, it } from 'vitest';
import { PRICING, PricingTable, UsageCalculator } from '../../src/usage/UsageCalculator.js';

const table = PricingTable.parse({
  version: 1,
  updatedAt: '2026-09-22',
  aliases: { 'claude-code': 'anthropic' },
  models: {
    anthropic: {
      'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      // No cache rates: the provider bills those tokens as plain input.
      'claude-legacy': { in: 4, out: 8 },
    },
    ollama: { '*': { in: 0, out: 0 } },
  },
});

describe('UsageCalculator', () => {
  const calc = new UsageCalculator(table);

  it('prices each kind of token at its own rate', () => {
    const cost = calc.cost('anthropic', 'claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toEqual({ usd: 2 + 10 + 0.2 + 2.5, source: 'table', matched: 'claude-sonnet-5' });
  });

  it('keeps sub-cent costs instead of rounding them to zero', () => {
    const cost = calc.cost('anthropic', 'claude-sonnet-5', {
      inputTokens: 120,
      outputTokens: 40,
    });
    expect(cost?.usd).toBeCloseTo((120 * 2 + 40 * 10) / 1_000_000, 12);
    expect(cost?.usd).toBeGreaterThan(0);
  });

  it('bills cache tokens as input when the rate is unknown', () => {
    const cost = calc.cost('anthropic', 'claude-legacy', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost?.usd).toBe(8);
  });

  it('falls back to the longest listed id the model starts with', () => {
    const cost = calc.cost('anthropic', 'claude-sonnet-5-20260101', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toMatchObject({ usd: 2, matched: 'claude-sonnet-5' });
  });

  it('prices a CLI harness on the API it actually runs', () => {
    expect(
      calc.cost('claude-code', 'claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toMatchObject({ usd: 2, source: 'table' });
  });

  it('prices anything on a provider with a wildcard', () => {
    expect(
      calc.cost('ollama', 'llama4:70b', { inputTokens: 5_000_000, outputTokens: 5_000_000 }),
    ).toMatchObject({ usd: 0, matched: '*' });
  });

  it('has no cost for an unknown model rather than a wrong one', () => {
    expect(
      calc.cost('anthropic', 'something-else', { inputTokens: 10, outputTokens: 10 }),
    ).toBeNull();
    expect(calc.cost('google', 'gemini-2.5-pro', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('lets a user override win over the table, by prefix too', () => {
    const withOverride = new UsageCalculator(table, {
      anthropic: { 'claude-sonnet-5': { in: 1, out: 1, cacheRead: null, cacheWrite: null } },
    });
    expect(
      withOverride.cost('anthropic', 'claude-sonnet-5-20260101', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toMatchObject({ usd: 2, source: 'override' });
  });
});

describe('the table that ships with the runner', () => {
  const calc = new UsageCalculator();

  it('parses, and says when it was read off the providers pages', () => {
    expect(PRICING.version).toBeGreaterThan(0);
    expect(PRICING.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(PRICING.sources).length).toBeGreaterThan(0);
  });

  it('prices every provider Comitiva can run', () => {
    expect(
      calc.cost('anthropic', 'claude-opus-5', { inputTokens: 1e6, outputTokens: 0 })?.usd,
    ).toBe(5);
    expect(
      calc.cost('openai-compatible', 'gpt-5.1', { inputTokens: 1e6, outputTokens: 0 })?.usd,
    ).toBe(1.25);
    expect(calc.cost('google', 'gemini-2.5-pro', { inputTokens: 1e6, outputTokens: 0 })?.usd).toBe(
      1.25,
    );
    expect(calc.cost('ollama', 'anything', { inputTokens: 1e6, outputTokens: 1e6 })?.usd).toBe(0);
    // The harnesses bill on the API behind them.
    expect(
      calc.cost('claude-code', 'claude-opus-5', { inputTokens: 1e6, outputTokens: 0 })?.usd,
    ).toBe(5);
    expect(calc.cost('codex', 'gpt-5.1', { inputTokens: 1e6, outputTokens: 0 })?.usd).toBe(1.25);
  });

  it('does not let a shorter id swallow a longer one', () => {
    // `gpt-5` is a prefix of both; each must keep its own price.
    expect(
      calc.cost('openai-compatible', 'gpt-5-mini', { inputTokens: 1e6, outputTokens: 0 })?.usd,
    ).toBe(0.25);
    expect(
      calc.cost('openai-compatible', 'gpt-5', { inputTokens: 1e6, outputTokens: 0 })?.usd,
    ).toBe(1.25);
  });
});
