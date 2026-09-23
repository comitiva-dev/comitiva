import { describe, expect, it } from 'vitest';
import type { Message } from '@comitiva/contract';
import { conversationMarkdown } from './markdown';

const msg = (over: Partial<Message>): Message => ({
  id: 'm',
  conversationId: 'c',
  role: 'user',
  content: [],
  status: 'complete',
  seq: 0,
  createdAt: '2026-09-23T12:00:00.000Z',
  error: null,
  ...over,
});

describe('conversationMarkdown', () => {
  it('writes the header, each message, tool calls and attachments', () => {
    const md = conversationMarkdown({
      conversation: { title: 'Launch plan', createdAt: '2026-09-23T11:59:00.000Z' },
      agentName: 'Planner',
      model: 'Anthropic · claude-sonnet-5',
      exportedAt: '2026-09-23T13:00:00.000Z',
      messages: [
        msg({
          content: [
            { type: 'text', text: 'Read the notes' },
            {
              type: 'document',
              name: 'notes.md',
              mediaType: 'text/markdown',
              source: { kind: 'file', path: 'x.md' },
            },
          ],
        }),
        msg({
          role: 'assistant',
          seq: 1,
          createdAt: '2026-09-23T12:00:05.000Z',
          content: [
            { type: 'text', text: 'Reading.' },
            {
              type: 'tool_use',
              id: 't1',
              toolServerId: 'filesystem',
              name: 'fs__read_file',
              input: { path: 'a```b' },
            },
            {
              type: 'tool_result',
              toolUseId: 't1',
              isError: false,
              durationMs: 12,
              content: [{ type: 'text', text: 'contents' }],
            },
            { type: 'text', text: 'Done.' },
          ],
        }),
        msg({
          role: 'assistant',
          seq: 2,
          status: 'error',
          error: { code: 'rate_limited', message: 'x', retryable: true },
        }),
      ],
    });
    expect(md).toMatchSnapshot();
    // The fence outgrows the backticks inside the input.
    expect(md).toContain('````json\n{\n  "path": "a```b"\n}\n````');
  });

  it('names an untitled conversation and marks a stopped reply', () => {
    const md = conversationMarkdown({
      conversation: { title: null, createdAt: '2026-09-23T11:59:00.000Z' },
      agentName: 'A',
      model: null,
      exportedAt: '2026-09-23T13:00:00.000Z',
      messages: [
        msg({ role: 'assistant', status: 'cancelled', content: [{ type: 'text', text: 'Half' }] }),
      ],
    });
    expect(md.startsWith('# Untitled conversation\n')).toBe(true);
    expect(md).not.toContain('Model:');
    expect(md).toContain('Half\n\n_Stopped._');
  });
});
