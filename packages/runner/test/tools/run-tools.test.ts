import { afterEach, describe, expect, it } from 'vitest';
import {
  AppError,
  providerDescriptors,
  type Message,
  type PermissionPolicy,
  type RunEvent,
  type StopReason,
  type ToolDef,
  type ToolServerLaunch,
} from '@comitiva/contract';
import { McpClientManager } from '../../src/mcp/McpClientManager.js';
import { streamTurn, UsageTracker } from '../../src/providers/api/shared.js';
import type {
  AdapterEvent,
  ProviderAdapter,
  RunContext,
  RunInput,
} from '../../src/providers/ProviderAdapter.js';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry.js';
import { RunManager } from '../../src/runs/RunManager.js';
import { toolLoop } from '../../src/runs/ToolLoop.js';
import {
  anthropicConnection,
  createFakeMcp,
  testAgent,
  userText,
  type FakeMcp,
} from '../../src/testing/index.js';
import { createLogger } from '../../src/util/logger.js';

/** One scripted model answer: some text, then the tool calls it makes. */
interface Step {
  text?: string;
  tools?: Array<{ id: string; name: string; input?: unknown }>;
}

/**
 * An API adapter driven by a script instead of a provider, running the real
 * toolLoop inside the real streamTurn.
 */
class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.anthropic.capabilities;
  readonly requests: Array<{ messages: Message[]; tools: ToolDef[] }> = [];

  constructor(private readonly steps: Step[]) {}

  testConnection(): never {
    throw new Error('unused');
  }

  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal,
      usage,
      toAppError: (e) => AppError.from(e),
      body: () =>
        toolLoop({
          ctx,
          usage,
          messages: input.messages,
          maxIterations: input.params.maxToolIterations,
          call: (messages, tools) => this.call(messages, tools, usage),
        }),
    });
  }

  private async *call(
    messages: Message[],
    tools: ToolDef[],
    usage: UsageTracker,
  ): AsyncGenerator<AdapterEvent, StopReason> {
    const step = this.steps[this.requests.length] ?? { text: 'done' };
    this.requests.push({ messages, tools });
    if (step.text) yield { type: 'run.text_delta', text: step.text };
    for (const t of step.tools ?? []) {
      yield {
        type: 'run.block',
        block: { type: 'tool_use', id: t.id, toolServerId: '', name: t.name, input: t.input ?? {} },
      };
    }
    usage.report({ input: 10, output: 5, final: true });
    return step.tools?.length ? 'tool_use' : 'end_turn';
  }
}

const notes: ToolServerLaunch = {
  id: 'srv-notes',
  name: 'Notes',
  transport: 'stdio',
  command: 'fake',
  args: [],
  env: {},
};

let managers: McpClientManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((m) => m.stopAll()));
  managers = [];
});

function setup(
  steps: Step[],
  opts: {
    policy?: PermissionPolicy;
    alwaysAllowed?: string[];
    servers?: ToolServerLaunch[];
    maxToolIterations?: number;
    fake?: FakeMcp;
  } = {},
) {
  const events: RunEvent[] = [];
  const fake = opts.fake ?? createFakeMcp();
  const logger = createLogger('silent');
  const mcp = new McpClientManager(logger, { open: fake.open });
  managers.push(mcp);
  const adapter = new ScriptedAdapter(steps);
  const registry = new ProviderRegistry();
  registry.register(adapter);
  const runs = new RunManager({ registry, emit: (e) => events.push(e), logger, mcp });
  const start = (runId = 'r1') =>
    runs.start({
      id: 'q',
      type: 'run.start',
      runId,
      conversationId: 'c1',
      agent: testAgent({
        permissionPolicy: opts.policy ?? 'ask',
        params: opts.maxToolIterations ? { maxToolIterations: opts.maxToolIterations } : {},
      }),
      connection: anthropicConnection('http://unused.test'),
      secret: 'k',
      messages: [userText('c1', 'hi')],
      toolServers: opts.servers ?? [notes],
      ...(opts.alwaysAllowed ? { alwaysAllowed: opts.alwaysAllowed } : {}),
    });
  const of = <T extends RunEvent['type']>(type: T, runId = 'r1') =>
    events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type && e.runId === runId);
  const terminal = async (runId = 'r1') => {
    await expect
      .poll(
        () =>
          events.find(
            (e) => e.runId === runId && (e.type === 'run.done' || e.type === 'run.error'),
          ),
        {
          timeout: 3000,
        },
      )
      .toBeDefined();
    return events.find(
      (e) => e.runId === runId && (e.type === 'run.done' || e.type === 'run.error'),
    )!;
  };
  const toolCall = async (toolUseId: string, runId = 'r1') => {
    await expect
      .poll(() => of('run.tool_call', runId).find((e) => e.toolUseId === toolUseId))
      .toBeDefined();
    return of('run.tool_call', runId).find((e) => e.toolUseId === toolUseId)!;
  };
  return { events, fake, mcp, adapter, runs, start, of, terminal, toolCall };
}

describe('Run with tools', () => {
  it('runs read-only tools without asking and feeds the result back to the model', async () => {
    const t = setup([
      {
        text: 'Let me look. ',
        tools: [{ id: 'u1', name: 'notes__read_note', input: { key: 'a' } }],
      },
      { text: 'It is empty.' },
    ]);
    t.start();
    expect(await t.terminal()).toMatchObject({ type: 'run.done', stopReason: 'end_turn' });

    expect(t.adapter.requests[0]!.tools.map((d) => d.name).sort()).toEqual([
      'notes__crash',
      'notes__delete_note',
      'notes__read_note',
      'notes__slow',
      'notes__write_note',
    ]);
    expect(t.of('run.block')[0]!.block).toEqual({
      type: 'tool_use',
      id: 'u1',
      toolServerId: 'srv-notes',
      name: 'notes__read_note',
      input: { key: 'a' },
    });
    expect(t.of('run.tool_call')[0]).toMatchObject({
      toolUseId: 'u1',
      toolServerId: 'srv-notes',
      toolName: 'read_note',
      requiresApproval: false,
    });
    expect(t.of('run.tool_result')[0]).toMatchObject({
      toolUseId: 'u1',
      isError: false,
      output: [{ type: 'text', text: '(empty)' }],
    });
    // The second call carries the assistant turn and the tool result.
    const second = t.adapter.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(second[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'u1' });
    // One usage for the whole turn, summed over both calls.
    expect(t.of('run.usage')).toEqual([
      expect.objectContaining({ inputTokens: 20, outputTokens: 10, estimated: false }),
    ]);
    expect(t.fake.calls).toEqual([{ server: 'srv-notes', tool: 'read_note', args: { key: 'a' } }]);
  });

  it('asks before a write and runs it once allowed', async () => {
    const t = setup([
      { tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: 'hi' } }] },
      { text: 'Saved.' },
    ]);
    t.start();
    expect(await t.toolCall('w1')).toMatchObject({
      requiresApproval: true,
      toolName: 'write_note',
    });
    // Nothing runs while the user decides.
    await new Promise((r) => setTimeout(r, 30));
    expect(t.fake.calls).toEqual([]);
    expect(t.of('run.tool_result')).toEqual([]);

    expect(t.runs.resolveApproval('r1', 'w1', 'allow')).toBe(true);
    expect(await t.terminal()).toMatchObject({ stopReason: 'end_turn' });
    expect(t.fake.notes.get('srv-notes:a')).toBe('hi');
    expect(t.of('run.tool_result')[0]).toMatchObject({ toolUseId: 'w1', isError: false });
  });

  it('tells the model when the user denies, without calling the server', async () => {
    const t = setup([
      { tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: 'hi' } }] },
      { text: 'OK, I will not.' },
    ]);
    t.start();
    await t.toolCall('w1');
    t.runs.resolveApproval('r1', 'w1', 'deny');
    expect(await t.terminal()).toMatchObject({ stopReason: 'end_turn' });
    expect(t.fake.calls).toEqual([]);
    expect(t.of('run.tool_result')[0]).toMatchObject({
      isError: true,
      durationMs: 0,
      output: [{ type: 'text', text: 'approval_denied: The user denied this action' }],
    });
    const result = t.adapter.requests[1]!.messages[2]!.content[0];
    expect(result).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('remembers allow-always for the rest of the run, and honors stored ones', async () => {
    const t = setup([
      { tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: '1' } }] },
      { tools: [{ id: 'w2', name: 'notes__write_note', input: { key: 'b', text: '2' } }] },
      { tools: [{ id: 'd1', name: 'notes__delete_note', input: { key: 'a' } }] },
      { text: 'Done.' },
    ]);
    t.start();
    await t.toolCall('w1');
    t.runs.resolveApproval('r1', 'w1', 'allow-always');
    // The second write runs without asking; delete is another tool, so it asks.
    expect(await t.toolCall('w2')).toMatchObject({ requiresApproval: false });
    expect(await t.toolCall('d1')).toMatchObject({ requiresApproval: true });
    t.runs.resolveApproval('r1', 'd1', 'allow');
    await t.terminal();
    expect(t.fake.notes.get('srv-notes:b')).toBe('2');

    // A decision recorded by the shell arrives in the next run.start.
    const next = setup(
      [{ tools: [{ id: 'w3', name: 'notes__write_note', input: { key: 'c', text: '3' } }] }, {}],
      { alwaysAllowed: ['srv-notes:write_note'] },
    );
    next.start();
    expect(await next.toolCall('w3')).toMatchObject({ requiresApproval: false });
    expect(await next.terminal()).toMatchObject({ stopReason: 'end_turn' });
  });

  it('allows writes without asking under allow-writes', async () => {
    const t = setup(
      [{ tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: 'x' } }] }, {}],
      { policy: 'allow-writes' },
    );
    t.start();
    expect(await t.toolCall('w1')).toMatchObject({ requiresApproval: false });
    await t.terminal();
    expect(t.fake.notes.get('srv-notes:a')).toBe('x');
  });

  it('hides and refuses tools that write under the read-only policy', async () => {
    const t = setup(
      [{ tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: 'x' } }] }, {}],
      { policy: 'read-only' },
    );
    t.start();
    await t.terminal();
    expect(t.adapter.requests[0]!.tools.map((d) => d.name).sort()).toEqual([
      'notes__crash',
      'notes__read_note',
      'notes__slow',
    ]);
    // A model that calls it anyway gets an error result, and the server is never called.
    expect(t.of('run.tool_call')).toEqual([]);
    expect(t.of('run.tool_result')[0]!.output[0]).toMatchObject({
      text: expect.stringMatching(/^invalid_request: There is no tool/),
    });
    expect(t.fake.calls).toEqual([]);
  });

  it('cancels while waiting for approval: no call, done(cancelled)', async () => {
    const t = setup([
      { tools: [{ id: 'w1', name: 'notes__write_note', input: { key: 'a', text: 'x' } }] },
    ]);
    t.start();
    await t.toolCall('w1');
    t.runs.cancel('r1');
    expect(await t.terminal()).toMatchObject({ type: 'run.done', stopReason: 'cancelled' });
    expect(t.of('run.usage')).toHaveLength(1);
    expect(t.fake.calls).toEqual([]);
    // A late answer is a no-op.
    expect(t.runs.resolveApproval('r1', 'w1', 'allow')).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.fake.calls).toEqual([]);
  });

  it('cancels during a slow tool: the server gets the cancel, the run ends at once', async () => {
    const t = setup([{ tools: [{ id: 's1', name: 'notes__slow', input: { ms: 10_000 } }] }]);
    t.start();
    await t.toolCall('s1');
    await expect.poll(() => t.fake.calls.length).toBe(1);
    const started = Date.now();
    t.runs.cancel('r1');
    expect(await t.terminal()).toMatchObject({ stopReason: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.of('run.tool_result')).toEqual([]);
  });

  it('stops at the iteration limit', async () => {
    const loop = { tools: [{ id: 'x', name: 'notes__read_note', input: { key: 'a' } }] };
    const t = setup(
      Array.from({ length: 10 }, (_, i) => ({ tools: [{ ...loop.tools[0]!, id: `x${i}` }] })),
      { maxToolIterations: 3 },
    );
    t.start();
    expect(await t.terminal()).toMatchObject({ stopReason: 'max_iterations' });
    expect(t.adapter.requests).toHaveLength(3);
    // The last call's tools are not run.
    expect(t.fake.calls).toHaveLength(2);
  });

  it('turns a server crash into an error result and restarts the server on the next call', async () => {
    const t = setup([
      { tools: [{ id: 'c1', name: 'notes__crash' }] },
      { tools: [{ id: 'r1', name: 'notes__read_note', input: { key: 'a' } }] },
      { text: 'Recovered.' },
    ]);
    t.start();
    expect(await t.terminal()).toMatchObject({ stopReason: 'end_turn' });
    const [crash, read] = t.of('run.tool_result');
    expect(crash).toMatchObject({ isError: true });
    expect(crash!.output[0]).toMatchObject({
      text: expect.stringMatching(/^tool_server_failed: /),
    });
    expect(read).toMatchObject({ isError: false });
    expect(t.fake.opens()).toBe(2);
  });

  it('fails the run with tool_server_failed when a server cannot start, then backs off', async () => {
    const fake = createFakeMcp();
    fake.failNextOpens(1);
    const t = setup([{ text: 'hi' }], { fake });
    t.start();
    expect(await t.terminal()).toMatchObject({ type: 'run.error', code: 'tool_server_failed' });
    // Within the backoff window the next run fails fast without spawning again.
    t.start('r2');
    expect(await t.terminal('r2')).toMatchObject({ type: 'run.error', code: 'tool_server_failed' });
    expect(fake.opens()).toBe(1);
  });

  it('reuses one server across runs, and runs two conversations at once', async () => {
    const t = setup([
      { tools: [{ id: 'a', name: 'notes__read_note', input: { key: 'x' } }] },
      { tools: [{ id: 'b', name: 'notes__read_note', input: { key: 'y' } }] },
    ]);
    t.start('r1');
    t.start('r2');
    await t.terminal('r1');
    await t.terminal('r2');
    expect(t.fake.opens()).toBe(1);
    expect(t.mcp.liveInstances()).toEqual([{ serverId: 'srv-notes', refs: 0, alive: true }]);
  });

  it('prefixes tool names per server so two servers can share a tool name', async () => {
    const other: ToolServerLaunch = { ...notes, id: 'srv-2', name: 'Notes' };
    const t = setup([{ text: 'x' }], { servers: [notes, other] });
    t.start();
    await t.terminal();
    const names = t.adapter.requests[0]!.tools.map((d) => d.name);
    expect(names).toContain('notes__read_note');
    expect(names).toContain('notes_2__read_note');
  });
});
