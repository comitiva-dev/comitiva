import {
  appendText,
  type Block,
  type Message,
  type StopReason,
  type ToolDef,
} from '@comitiva/contract';
import type { UsageTracker } from '../providers/api/shared.js';
import type { AdapterEvent, RunContext } from '../providers/ProviderAdapter.js';
import { loopMessage } from './history.js';

export const DEFAULT_MAX_ITERATIONS = 25;

/** One model call: yields deltas and complete `tool_use` blocks, returns the stop reason. */
export type ModelCall = (
  messages: Message[],
  tools: ToolDef[],
) => AsyncGenerator<AdapterEvent, StopReason>;

/**
 * The tool loop API adapters run inside `streamTurn` (docs/tools.md): call the
 * model → for each `tool_use`, `ctx.callTool` (gate, approval, MCP) → append
 * the assistant turn and the results → call again, until the model stops
 * asking for tools or `maxIterations` model calls were made. Tools run one at
 * a time, in order. Usage accumulates across calls (one `run.usage` at the
 * end, from streamTurn). Cancel rejects `callTool`, which streamTurn turns
 * into `done(cancelled)`.
 */
export async function* toolLoop(opts: {
  call: ModelCall;
  ctx: RunContext;
  messages: Message[];
  usage: UsageTracker;
  maxIterations?: number | undefined;
}): AsyncGenerator<AdapterEvent, StopReason> {
  const { ctx, usage } = opts;
  const max = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const conversationId = opts.messages[0]?.conversationId ?? '';
  let messages = [...opts.messages];
  for (let i = 0; ; i++) {
    if (i > 0) usage.nextCall();
    let content: Block[] = [];
    const it = opts.call(messages, ctx.tools);
    let next = await it.next();
    while (!next.done) {
      let event = next.value;
      if (event.type === 'run.text_delta') content = appendText(content, event.text);
      else if (event.type === 'run.block') {
        if (event.block.type === 'tool_use') {
          event = {
            ...event,
            block: { ...event.block, toolServerId: ctx.toolServerId(event.block.name) },
          };
        }
        content.push(event.block);
      }
      yield event;
      next = await it.next();
    }
    const stop = next.value;
    const uses = content.filter((b) => b.type === 'tool_use');
    // Some providers (Ollama, Gemini) end with a plain stop even when they call tools.
    if (uses.length === 0 || stop === 'max_tokens') return stop;
    if (i + 1 >= max) return 'max_iterations';
    const results: Block[] = [];
    for (const use of uses) {
      const r = await ctx.callTool(use.id, use.name, use.input);
      results.push({
        type: 'tool_result',
        toolUseId: use.id,
        content: r.content,
        isError: r.isError,
      });
    }
    messages = [
      ...messages,
      loopMessage(conversationId, 'assistant', content),
      loopMessage(conversationId, 'tool', results),
    ];
  }
}
