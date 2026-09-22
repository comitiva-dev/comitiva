import { describe, expect, it } from 'vitest';
import type { Block, Message, StopReason, ToolDef } from '@comitiva/contract';
import { UsageTracker } from '../../src/providers/api/shared.js';
import { toolLoop } from '../../src/runs/ToolLoop.js';
import type { AdapterEvent, RunContext } from '../../src/providers/ProviderAdapter.js';
import { countPrompt } from '../../src/usage/Tokenizer.js';

const message = (role: Message['role'], content: Block[], seq = 1): Message => ({
  id: `m${seq}`,
  conversationId: 'c1',
  role,
  content,
  status: 'complete',
  seq,
  error: null,
  createdAt: '2026-09-22T00:00:00.000Z',
});

const text = (t: string): Block[] => [{ type: 'text', text: t }];

describe('UsageTracker', () => {
  it('estimates only until the provider reports, then trusts it', () => {
    const tracker = new UsageTracker(100, 'system');
    tracker.addText('a guess about the output');
    expect(tracker.event()).toMatchObject({ inputTokens: 100, estimated: true });

    tracker.report({ input: 7, output: 3, final: true });
    expect(tracker.event()).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      estimated: false,
    });
  });

  it('leaves cache counters out when nothing reported them', () => {
    const tracker = new UsageTracker(1);
    tracker.report({ input: 1, output: 1, final: true });
    expect(tracker.event()).not.toHaveProperty('cacheReadTokens');
    expect(tracker.event()).not.toHaveProperty('cacheWriteTokens');
  });

  it('re-estimates the prompt as the history grows', () => {
    const tracker = new UsageTracker(countPrompt('sys', []), 'sys');
    const before = tracker.event();
    tracker.seed([message('user', text('a question'.repeat(50)))]);
    const after = tracker.event();
    expect(after).toMatchObject({ estimated: true });
    expect('inputTokens' in after ? after.inputTokens : 0).toBeGreaterThan(
      'inputTokens' in before ? before.inputTokens : 0,
    );
  });
});

describe('the tool loop', () => {
  /** A model that streams a tool call, then an answer, and reports no usage. */
  const scripted = (calls: string[][]) =>
    async function* (messages: Message[]): AsyncGenerator<AdapterEvent, StopReason> {
      const names = calls[seen] ?? [];
      seen += 1;
      recorded.push(messages);
      for (const [i, name] of names.entries()) {
        yield {
          type: 'run.block',
          block: { type: 'tool_use', id: `u${i}`, toolServerId: '', name, input: {} },
        };
      }
      yield { type: 'run.text_delta', text: 'ok' };
      return names.length ? 'tool_use' : 'end_turn';
    };

  let seen = 0;
  let recorded: Message[][] = [];

  const ctx: RunContext = {
    tools: [] as ToolDef[],
    toolServerId: () => 'srv',
    callTool: async () => ({
      content: [{ type: 'text' as const, text: 'a long tool result '.repeat(200) }],
      isError: false,
    }),
  } as unknown as RunContext;

  it('re-seeds the estimate from the history the tool results grew', async () => {
    seen = 0;
    recorded = [];
    const messages = [message('user', text('hi'))];
    const usage = new UsageTracker(countPrompt('', messages), '');
    const first = usage.event();

    const it = toolLoop({ ctx, usage, messages, call: scripted([['srv__read'], []]) });
    while (!(await it.next()).done);

    // Two model calls ran, the second one seeing the bulky tool result.
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.length).toBeGreaterThan(recorded[0]!.length);
    const after = usage.event();
    expect(after).toMatchObject({ estimated: true });
    expect('inputTokens' in after ? after.inputTokens : 0).toBeGreaterThan(
      'inputTokens' in first ? first.inputTokens : 0,
    );
  });
});
