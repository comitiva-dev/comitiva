import { describe, expect, it } from 'vitest';
import { ipcEventChannels, ipcEvents, ipcInvoke, ipcInvokeChannels } from '../src/index.js';
import { anthropicConnection } from './fixtures.js';

describe('IPC contract', () => {
  it('lists every invoke channel exactly once', () => {
    expect([...ipcInvokeChannels].sort()).toEqual(Object.keys(ipcInvoke).sort());
  });

  it('lists every event channel exactly once', () => {
    expect([...ipcEventChannels].sort()).toEqual(Object.keys(ipcEvents).sort());
  });

  it('validates connection drafts per provider', () => {
    const schema = ipcInvoke['connections.create'].input;
    expect(
      schema.safeParse({
        name: 'Groq',
        provider: 'openai-compatible',
        config: { baseUrl: 'https://api.groq.com/openai/v1', preset: 'groq' },
        apiKey: 'k',
      }).success,
    ).toBe(true);
    // openai-compatible needs a base URL; names cannot be blank; keys cannot be empty.
    expect(schema.safeParse({ name: 'x', provider: 'openai-compatible', config: {} }).success).toBe(
      false,
    );
    expect(schema.safeParse({ name: '  ', provider: 'ollama', config: {} }).success).toBe(false);
    expect(
      schema.safeParse({ name: 'x', provider: 'anthropic', config: {}, apiKey: '' }).success,
    ).toBe(false);
  });

  it('accepts CLI drafts without a key and applies their defaults', () => {
    const schema = ipcInvoke['connections.create'].input;
    const codex = schema.parse({ name: 'Codex', provider: 'codex', config: {} });
    expect(codex.config).toEqual({ extraArgs: [], sandbox: 'workspace-write' });
    const claude = schema.parse({
      name: 'Claude Code',
      provider: 'claude-code',
      config: { binaryPath: '/usr/local/bin/claude', extraArgs: ['--effort', 'low'] },
      apiKey: 'ignored',
    });
    // CLI harnesses use their own login: a key is stripped, never stored.
    expect(claude).not.toHaveProperty('apiKey');
    expect(
      schema.safeParse({ name: 'x', provider: 'codex', config: { sandbox: 'yolo' } }).success,
    ).toBe(false);
    // gemini-cli has no adapter yet.
    expect(schema.safeParse({ name: 'x', provider: 'gemini-cli', config: {} }).success).toBe(false);
  });

  it('validates binary detection input', () => {
    const schema = ipcInvoke['connections.detectBinary'].input;
    expect(schema.safeParse({ provider: 'claude-code' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'codex', binaryPath: '/x/codex' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'anthropic' }).success).toBe(false);
  });

  it('requires an id or a probe to test or list models', () => {
    const schema = ipcInvoke['connections.test'].input;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: 'c1' }).success).toBe(true);
    expect(schema.safeParse({ probe: { provider: 'ollama', config: {} } }).success).toBe(true);
  });

  it('strips anything but the declared summary fields from outputs', () => {
    const out = ipcInvoke['connections.list'].output.parse([
      { connection: anthropicConnection, hasSecret: true, lastTest: null, apiKey: 'sk-secret' },
    ]);
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('accepts null to remove a key and rejects empty strings', () => {
    const schema = ipcInvoke['connections.update'].input;
    expect(schema.safeParse({ id: 'c1', patch: { apiKey: null } }).success).toBe(true);
    expect(schema.safeParse({ id: 'c1', patch: { apiKey: '' } }).success).toBe(false);
  });
});

describe('agent IPC', () => {
  const minimal = { name: ' Writer ', avatar: { color: 'indigo' }, connectionId: 'c1' };

  it('applies draft defaults', () => {
    expect(ipcInvoke['agents.create'].input.parse(minimal)).toEqual({
      name: 'Writer',
      avatar: { color: 'indigo' },
      connectionId: 'c1',
      model: null,
      role: '',
      params: {},
      tags: [],
      toolServerIds: [],
      roots: [],
      permissionPolicy: 'ask',
    });
  });

  it('turns a blank model into null (use the connection default)', () => {
    const create = ipcInvoke['agents.create'].input;
    expect(create.parse({ ...minimal, model: '  ' }).model).toBeNull();
    expect(create.parse({ ...minimal, model: ' gpt-5 ' }).model).toBe('gpt-5');
    const update = ipcInvoke['agents.update'].input;
    expect(update.parse({ id: 'a1', patch: { model: '' } }).patch).toEqual({ model: null });
    expect(update.parse({ id: 'a1', patch: {} }).patch).toEqual({});
  });

  it('rejects bad names, params and avatars', () => {
    const create = ipcInvoke['agents.create'].input;
    expect(create.safeParse({ ...minimal, name: '  ' }).success).toBe(false);
    expect(create.safeParse({ ...minimal, params: { temperature: 3 } }).success).toBe(false);
    expect(create.safeParse({ ...minimal, params: { maxTokens: 0 } }).success).toBe(false);
    expect(create.safeParse({ ...minimal, avatar: { color: 'mauve' } }).success).toBe(false);
  });

  it('defaults settings and validates patches', () => {
    expect(ipcInvoke['settings.get'].output.parse({})).toEqual({
      sampleAgentOffer: 'pending',
      language: 'system',
      autoUpdate: true,
    });
    expect(ipcInvoke['settings.update'].input.safeParse({ sampleAgentOffer: 'x' }).success).toBe(
      false,
    );
    expect(ipcInvoke['settings.update'].input.safeParse({ language: 'fr' }).success).toBe(false);
    expect(ipcInvoke['settings.update'].input.safeParse({ language: 'pt-BR' }).success).toBe(true);
  });
});

describe('ipc-channels', () => {
  it('only accepts channel names that exist in the schemas', () => {
    // Compile-time guard: every listed name must be a declared channel.
    const invoke: readonly (keyof typeof ipcInvoke)[] = ipcInvokeChannels;
    const events: readonly (keyof typeof ipcEvents)[] = ipcEventChannels;
    expect(invoke.length + events.length).toBeGreaterThan(0);
  });

  it('accepts user content with text, images or documents, never empty or tool blocks', () => {
    const schema = ipcInvoke['messages.send'].input;
    const text = (t: string) => ({ type: 'text', text: t });
    expect(schema.safeParse({ conversationId: 'c', content: [text('hi')] }).success).toBe(true);
    expect(schema.safeParse({ conversationId: 'c', content: [] }).success).toBe(false);
    expect(schema.safeParse({ conversationId: 'c', content: [text('  ')] }).success).toBe(false);
    expect(
      schema.safeParse({
        conversationId: 'c',
        content: [{ type: 'tool_use', id: 't', toolServerId: 's', name: 'n', input: {} }],
      }).success,
    ).toBe(false);
  });

  it('defaults conversation listing to non-archived and message pages to 100', () => {
    expect(ipcInvoke['conversations.list'].input.parse(undefined)).toEqual({ archived: false });
    expect(ipcInvoke['messages.list'].input.parse({ conversationId: 'c' })).toEqual({
      conversationId: 'c',
      limit: 100,
    });
    expect(ipcInvoke['conversations.rename'].input.safeParse({ id: 'c', title: ' ' }).success).toBe(
      false,
    );
  });

  it('carries a positive rev on live message events', () => {
    const delta = ipcEvents['message.delta'];
    expect(
      delta.safeParse({ conversationId: 'c', messageId: 'm', rev: 1, text: 'x' }).success,
    ).toBe(true);
    expect(
      delta.safeParse({ conversationId: 'c', messageId: 'm', rev: 0, text: 'x' }).success,
    ).toBe(false);
  });
});

describe('tool server IPC', () => {
  const create = ipcInvoke['toolServers.create'].input;

  it('accepts stdio and http servers with plain values and new secrets', () => {
    const stdio = create.parse({
      name: ' Search ',
      spec: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'search-mcp'],
        env: { API_KEY: { secret: 'k' }, REGION: { value: 'eu' } },
      },
    });
    expect(stdio).toMatchObject({ name: 'Search', enabled: true });
    expect(
      create.safeParse({
        name: 'Remote',
        spec: {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: { secret: 'Bearer x' } },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects bad commands, urls and names', () => {
    const stdio = (env: Record<string, unknown>, command = 'x') => ({
      name: 'x',
      spec: { transport: 'stdio', command, env },
    });
    expect(create.safeParse(stdio({}, ' ')).success).toBe(false);
    expect(create.safeParse(stdio({ 'BAD NAME': { value: '1' } })).success).toBe(false);
    expect(create.safeParse(stdio({ OK: { secret: '' } })).success).toBe(false);
    expect(
      create.safeParse({ name: 'x', spec: { transport: 'http', url: 'file:///etc/passwd' } })
        .success,
    ).toBe(false);
  });

  it('decides approvals with a known decision only', () => {
    const decide = ipcInvoke['approvals.decide'].input;
    expect(
      decide.safeParse({ conversationId: 'c', toolUseId: 't', decision: 'allow-always' }).success,
    ).toBe(true);
    expect(
      decide.safeParse({ conversationId: 'c', toolUseId: 't', decision: 'maybe' }).success,
    ).toBe(false);
  });

  it('defaults the pending approval to null on conversation events', () => {
    const e = ipcEvents['conversation.updated'].parse({
      conversation: {
        id: 'c',
        agentId: 'a',
        title: null,
        status: 'idle',
        harnessSessionId: null,
        archived: false,
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(e.pendingApproval).toBeNull();
  });

  it('tests a saved server or unsaved settings', () => {
    const test = ipcInvoke['toolServers.test'].input;
    expect(test.parse({ id: 'srv' })).toEqual({ id: 'srv' });
    const unsaved = test.parse({ spec: { transport: 'stdio', command: 'npx' } });
    expect(unsaved).toEqual({ spec: { transport: 'stdio', command: 'npx', args: [], env: {} } });
    expect(
      test.safeParse({
        id: 'srv',
        spec: {
          transport: 'http',
          url: 'https://x.test/mcp',
          headers: { A: { keepSecret: true } },
        },
      }).success,
    ).toBe(true);
    expect(test.safeParse({}).success).toBe(false);
  });

  it('validates the Google Drive client and never returns secrets in the status', () => {
    const configure = ipcInvoke['googleDrive.configure'].input;
    expect(configure.safeParse({ clientId: ' id.apps.googleusercontent.com ' }).success).toBe(true);
    expect(configure.safeParse({ clientId: 'x', clientSecret: { value: 's' } }).success).toBe(true);
    expect(configure.safeParse({ clientId: 'x', clientSecret: { keepSecret: true } }).success).toBe(
      true,
    );
    expect(configure.safeParse({ clientId: ' ' }).success).toBe(false);
    expect(configure.safeParse({ clientId: 'x', clientSecret: { value: '' } }).success).toBe(false);
    const status = ipcInvoke['googleDrive.getStatus'].output.parse({
      clientConfigured: true,
      clientId: 'x',
      hasClientSecret: true,
      state: 'connected',
      email: 'a@b.test',
      accessToken: 'leak',
      clientSecret: 'leak',
    });
    expect(JSON.stringify(status)).not.toContain('leak');
  });
});

describe('usage IPC', () => {
  const range = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-22T00:00:00.000Z' };

  it('defaults the timezone offset to UTC', () => {
    const parsed = ipcInvoke['usage.summary'].input.parse(range);
    expect(parsed.tzOffsetMinutes).toBe(0);
  });

  it('refuses an offset beyond the real ones and a blank model', () => {
    expect(
      ipcInvoke['usage.summary'].input.safeParse({ ...range, tzOffsetMinutes: 900 }).success,
    ).toBe(false);
    expect(
      ipcInvoke['usage.clearPrice'].input.safeParse({ provider: 'anthropic', model: '' }).success,
    ).toBe(false);
  });

  it('exports records unless the summary is asked for', () => {
    expect(ipcInvoke['usage.export'].input.parse(range).shape).toBe('records');
    expect(ipcInvoke['usage.export'].input.parse({ ...range, shape: 'summary' }).shape).toBe(
      'summary',
    );
  });

  it('keeps cache prices optional but the token ones required', () => {
    const prices = ipcInvoke['usage.setPrice'].input;
    const ok = prices.parse({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      prices: { inputPer1M: 3, outputPer1M: 15 },
    });
    expect(ok.prices.cacheReadPer1M).toBeNull();
    expect(
      prices.safeParse({ provider: 'anthropic', model: 'm', prices: { inputPer1M: 3 } }).success,
    ).toBe(false);
  });
});
