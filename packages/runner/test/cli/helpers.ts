import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '../../src/providers/ProviderAdapter.js';
import { UsageTracker } from '../../src/providers/api/shared.js';
import type { HarnessParser, ParserOptions } from '../../src/providers/cli/parsers/types.js';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function fixtureLines(harness: 'claude-code' | 'codex', name: string): unknown[] {
  return readFileSync(`${fixtures}${harness}/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

export function fixtureStderr(harness: 'claude-code' | 'codex', name: string): string {
  return readFileSync(`${fixtures}${harness}/${name}.stderr`, 'utf8');
}

/** Feeds a fixture through a parser; returns its events and usage. */
export function replay(
  make: (opts: ParserOptions) => HarnessParser,
  lines: unknown[],
): { parser: HarnessParser; events: AdapterEvent[]; usage: UsageTracker; logs: string[] } {
  const usage = new UsageTracker(0);
  const logs: string[] = [];
  const parser = make({ usage, log: (_l, m) => logs.push(m), idPrefix: 't_' });
  const events = lines.flatMap((l) => parser.push(l));
  return { parser, events, usage, logs };
}

export const textOf = (events: AdapterEvent[]): string =>
  events.map((e) => (e.type === 'run.text_delta' ? e.text : '')).join('');

export const ok = { code: 0, signal: null };
export const failed = { code: 1, signal: null };

/** The fake harness binaries, built into dist/ by the test script (tsup). */
export const bins = {
  claude: fileURLToPath(new URL('../../dist/testing/bin/fake-claude', import.meta.url)),
  codex: fileURLToPath(new URL('../../dist/testing/bin/fake-codex', import.meta.url)),
};
