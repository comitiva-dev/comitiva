import { describe, expect, it } from 'vitest';
import type { AppError } from '@comitiva/contract';
import {
  CODEX_TOOL_SERVER,
  CodexParser,
  turnFailed,
} from '../../src/providers/cli/parsers/codex.js';
import { failed, fixtureLines, fixtureStderr, ok, replay, textOf } from './helpers.js';

const parse = (name: string) => replay((o) => new CodexParser(o), fixtureLines('codex', name));

function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('did not throw');
}

describe('CodexParser (recorded fixtures)', () => {
  it('streams a simple turn one message at a time, with exact usage', () => {
    const { parser, events, usage } = parse('simple');
    expect(events).toEqual([
      { type: 'run.session', harnessSessionId: '01a0b7b7-c6e0-7b00-a9b1-8ffae2220025' },
      { type: 'run.text_delta', text: 'hello world' },
    ]);
    expect(parser.finish(ok, '')).toBe('end_turn');
    expect(usage.event()).toEqual({
      type: 'run.usage',
      inputTokens: 14282 - 11008,
      outputTokens: 6,
      cacheReadTokens: 11008,
      cacheWriteTokens: 0,
      estimated: false,
    });
  });

  it('separates consecutive messages', () => {
    expect(textOf(parse('resume').events)).toMatch(/report both answers\.\n\nYou asked/);
  });

  it('reports shell commands and file changes as tool blocks', () => {
    const { events } = parse('tools');
    const blocks = events.flatMap((e) => (e.type === 'run.block' ? [e.block] : []));
    expect(blocks.map((b) => b.type)).toEqual([
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
    ]);
    expect(blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 't_item_1',
      toolServerId: CODEX_TOOL_SERVER,
      name: 'shell',
    });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', toolUseId: 't_item_1', isError: false });
    expect(JSON.stringify(blocks[1])).toContain('the secret word is plum');
    expect(blocks[2]).toMatchObject({
      name: 'apply_patch',
      input: { changes: [{ path: '/work/out.txt', kind: 'add' }] },
    });
    expect(blocks[3]).toMatchObject({
      content: [{ type: 'text', text: 'add /work/out.txt' }],
      isError: false,
    });
    expect(textOf(events)).toContain('The secret word is **plum**.');
  });

  it('marks failed tools (sandbox failure, MCP approval) as errors', () => {
    const { events, parser } = parse('sandbox-failed');
    const results = events.flatMap((e) =>
      e.type === 'run.block' && e.block.type === 'tool_result' ? [e.block] : [],
    );
    expect(results.length).toBe(3);
    expect(results.every((r) => r.isError)).toBe(true);
    expect(JSON.stringify(results[0])).toContain('requires approval');
    expect(parser.finish(ok, '')).toBe('end_turn');
  });

  it('maps a 401 turn failure to not_logged_in, logging the reconnects', () => {
    const { parser, events, logs } = parse('not-logged-in');
    expect(textOf(events)).toBe('');
    expect(logs.length).toBeGreaterThan(5);
    const err = thrown(() => parser.finish(failed, ''));
    expect(err.code).toBe('not_logged_in');
    expect(err.message).toContain('codex login');
  });

  it('maps a JSON provider error by status', () => {
    const err = thrown(() => parse('bad-model').parser.finish(failed, ''));
    expect(err.code).toBe('provider_error');
    expect(err.message).toContain("The 'no-such-model' model is not supported");
    expect(turnFailed('{"status":429,"error":{"message":"slow down"}}').code).toBe('rate_limited');
    expect(turnFailed('unexpected status 503 Service Unavailable').code).toBe(
      'provider_unavailable',
    );
    expect(turnFailed('something odd').code).toBe('provider_error');
  });

  it('recognizes a lost thread from stderr', () => {
    const { parser } = replay((o) => new CodexParser(o), []);
    const stderr = fixtureStderr('codex', 'bad-session');
    expect(parser.sessionNotFound(stderr)).toBe(true);
    expect(() => parser.finish(failed, stderr)).toThrow(/no rollout found/);
  });

  it('resumes with a shell tool call and keeps the thread id', () => {
    const { events, parser } = parse('resume-tool');
    expect(events[0]).toEqual({
      type: 'run.session',
      harnessSessionId: '01a0b7b9-1be7-73a1-ac97-ef9ceda1c866',
    });
    expect(events.some((e) => e.type === 'run.block' && e.block.type === 'tool_use')).toBe(true);
    expect(parser.finish(ok, '')).toBe('end_turn');
  });
});
