import { describe, expect, it } from 'vitest';
import { AppError } from '@comitiva/contract';
import {
  CLAUDE_CODE_TOOL_SERVER,
  ClaudeCodeParser,
} from '../../src/providers/cli/parsers/claudeCode.js';
import { failed, fixtureLines, fixtureStderr, ok, replay, textOf } from './helpers.js';

const parse = (name: string) =>
  replay((o) => new ClaudeCodeParser(o), fixtureLines('claude-code', name));

describe('ClaudeCodeParser (recorded fixtures)', () => {
  it('streams a simple turn: session, token deltas, exact usage, end_turn', () => {
    const { parser, events, usage } = parse('simple');
    expect(events[0]).toEqual({
      type: 'run.session',
      harnessSessionId: 'ea44fb59-c0f4-4844-bcc0-bbab651e2c23',
    });
    expect(textOf(events)).toBe('hello world');
    // Text comes from the deltas only, not again from the complete assistant message.
    expect(events.filter((e) => e.type === 'run.text_delta')).toHaveLength(1);
    expect(parser.finish(ok, '')).toBe('end_turn');
    expect(usage.event()).toEqual({
      type: 'run.usage',
      inputTokens: 2,
      outputTokens: 5,
      cacheReadTokens: 518,
      cacheWriteTokens: 2085,
      estimated: false,
    });
  });

  it('reports the tool calls the harness ran, and separates text around them', () => {
    const { parser, events } = parse('resume-tool');
    const blocks = events.flatMap((e) => (e.type === 'run.block' ? [e.block] : []));
    expect(blocks).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_01CR27d5qLRTod3ckjovfAzJ',
        toolServerId: CLAUDE_CODE_TOOL_SERVER,
        name: 'Read',
        input: { file_path: '/work/note.txt' },
      },
      {
        type: 'tool_result',
        toolUseId: 'toolu_01CR27d5qLRTod3ckjovfAzJ',
        content: [{ type: 'text', text: '1\tnote: the secret word is plum\n2\t' }],
        isError: false,
      },
    ]);
    expect(textOf(events)).toBe(
      'Earlier you asked me to reply with exactly "hello world". I\'ll read note.txt now.\n\nThe secret word is **plum**.',
    );
    // Thinking is not surfaced.
    expect(textOf(events)).not.toContain('sig');
    expect(parser.finish(ok, '')).toBe('end_turn');
  });

  it('maps "not logged in" to not_logged_in with the login command', () => {
    const { parser, events } = parse('not-logged-in');
    expect(textOf(events)).toBe('');
    const err = (() => {
      try {
        parser.finish(failed, '');
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err?.code).toBe('not_logged_in');
    expect(err?.message).toContain('claude auth login');
  });

  it('recognizes a lost session (for the replay retry) and fails otherwise', () => {
    const stderr = fixtureStderr('claude-code', 'bad-session');
    const { parser } = parse('bad-session');
    expect(parser.sessionNotFound(stderr)).toBe(true);
    expect(() => parser.finish(failed, stderr)).toThrow(/No conversation found/);
    expect(parse('simple').parser.sessionNotFound('')).toBe(false);
  });

  it('streams a long turn in many deltas', () => {
    const { events } = parse('long');
    expect(events.filter((e) => e.type === 'run.text_delta').length).toBeGreaterThan(20);
    expect(textOf(events)).toMatch(/^1\n2\n3\n/);
  });

  it('falls back to the complete message when no deltas were streamed', () => {
    const lines = fixtureLines('claude-code', 'simple').filter(
      (l) => (l as { type: string }).type !== 'stream_event',
    );
    const { events } = replay((o) => new ClaudeCodeParser(o), lines);
    expect(textOf(events)).toBe('hello world');
  });

  it('fails a run that exits without a result, with the stderr detail', () => {
    const { parser } = replay((o) => new ClaudeCodeParser(o), []);
    expect(() => parser.finish({ code: 2, signal: null }, 'boom\nError: bad flag\n')).toThrow(
      /exited \(2\) without a result: Error: bad flag/,
    );
  });

  it('ignores subagent traffic and junk', () => {
    const { events } = replay(
      (o) => new ClaudeCodeParser(o),
      [
        null,
        'text',
        {
          type: 'stream_event',
          parent_tool_use_id: 'toolu_x',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
        },
      ],
    );
    expect(events).toEqual([]);
  });
});
