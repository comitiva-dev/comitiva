import { describe, expect, it } from 'vitest';
import { Agent, Block, Connection, Message, UsagePolicy, appendText } from '../src/index.js';
import { agent, anthropicConnection, userMessage } from './fixtures.js';

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

describe('Agent', () => {
  it('accepts a valid agent', () => {
    expect(Agent.parse(agent)).toEqual(agent);
  });

  it('types the avatar as a palette color with an optional emoji', () => {
    expect(Agent.safeParse({ ...agent, avatar: { color: 'teal' } }).success).toBe(true);
    expect(Agent.safeParse({ ...agent, avatar: '🔎' }).success).toBe(false);
    expect(Agent.safeParse({ ...agent, avatar: { color: '#ff0000' } }).success).toBe(false);
    expect(Agent.safeParse({ ...agent, avatar: { color: 'teal', emoji: '' } }).success).toBe(false);
  });

  it('trims tags and limits their length and count', () => {
    expect(Agent.parse({ ...agent, tags: [' writing '] }).tags).toEqual(['writing']);
    expect(Agent.safeParse({ ...agent, tags: ['x'.repeat(33)] }).success).toBe(false);
    expect(
      Agent.safeParse({ ...agent, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success,
    ).toBe(false);
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

describe('appendText', () => {
  it('extends the last text block or starts one after a tool block', () => {
    const tool = {
      type: 'tool_use' as const,
      id: 't',
      toolServerId: 'harness:codex',
      name: 'shell',
      input: {},
    };
    const start = appendText([], 'Hel');
    expect(appendText(start, 'lo')).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(appendText([...start, tool], 'x')).toEqual([
      ...start,
      tool,
      { type: 'text', text: 'x' },
    ]);
    expect(start).toEqual([{ type: 'text', text: 'Hel' }]);
  });
});
