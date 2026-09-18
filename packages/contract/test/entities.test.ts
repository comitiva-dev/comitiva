import { describe, expect, it } from 'vitest';
import { Block, Connection, Message, UsagePolicy } from '../src/index.js';
import { anthropicConnection, userMessage } from './fixtures.js';

describe('Connection', () => {
  it('accepts a valid anthropic connection', () => {
    expect(Connection.parse(anthropicConnection)).toEqual(anthropicConnection);
  });

  it('rejects a kind that does not match the provider', () => {
    expect(Connection.safeParse({ ...anthropicConnection, kind: 'cli' }).success).toBe(false);
  });

  it('types config by provider', () => {
    const r = Connection.safeParse({
      ...anthropicConnection,
      provider: 'openai-compatible',
      config: {},
    });
    expect(r.success).toBe(false); // openai-compatible requires baseUrl
  });

  it('applies provider config defaults', () => {
    const ollama = Connection.parse({ ...anthropicConnection, provider: 'ollama', config: {} });
    expect(ollama.config).toEqual({ baseUrl: 'http://localhost:11434' });
  });
});

describe('Block', () => {
  it('parses every block type', () => {
    const blocks: unknown[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
      {
        type: 'document',
        name: 'a.pdf',
        mediaType: 'application/pdf',
        source: { kind: 'file', path: '/a.pdf' },
      },
      {
        type: 'tool_use',
        id: 'tu_1',
        toolServerId: 'fs',
        name: 'fs__read_file',
        input: { path: 'a' },
      },
      {
        type: 'tool_result',
        toolUseId: 'tu_1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ];
    for (const b of blocks) expect(Block.safeParse(b).success).toBe(true);
  });

  it('does not allow tool_use inside a tool_result', () => {
    const r = Block.safeParse({
      type: 'tool_result',
      toolUseId: 'tu_1',
      content: [{ type: 'tool_use', id: 'x', toolServerId: 'fs', name: 'n', input: {} }],
      isError: false,
    });
    expect(r.success).toBe(false);
  });
});

describe('Message', () => {
  it('rejects unknown roles and statuses', () => {
    expect(Message.safeParse({ ...userMessage, role: 'system' }).success).toBe(false);
    expect(Message.safeParse({ ...userMessage, status: 'done' }).success).toBe(false);
  });
});

describe('UsagePolicy', () => {
  it('validates time windows as HH:MM', () => {
    const base = { connectionId: 'c', maxTokensDay: null, maxCostDay: null, maxConcurrent: 2 };
    expect(
      UsagePolicy.safeParse({ ...base, windowStart: '09:00', windowEnd: '18:30' }).success,
    ).toBe(true);
    expect(UsagePolicy.safeParse({ ...base, windowStart: '25:00', windowEnd: null }).success).toBe(
      false,
    );
  });
});
