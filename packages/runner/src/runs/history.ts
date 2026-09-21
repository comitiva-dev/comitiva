import type { Block, Message, MessageRole, ToolResultBlock } from '@comitiva/contract';

/**
 * Turns stored messages into the strict alternation providers expect:
 * `assistant` (text + tool_use) → `tool` (their tool_results) → … Shells may
 * store one reply per run with text, tool_use and tool_result blocks
 * interleaved (docs/tools.md); this splits it. Every tool_use gets a result:
 * one that never finished (cancel, crash, iteration limit) gets an error
 * result, since providers reject a tool_use without one. Results without a
 * matching tool_use are dropped.
 */
export function normalizeHistory(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' && m.role !== 'tool') {
      out.push(m);
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'tool_result') append(out, m, 'tool', block);
      else append(out, m, 'assistant', block);
    }
  }
  return pairToolResults(out).filter((m) => m.content.length > 0);
}

function append(out: Message[], source: Message, role: MessageRole, block: Block): void {
  const last = out.at(-1);
  if (last && last.role === role && last.id === source.id) last.content.push(block);
  else out.push({ ...source, role, content: [block] });
}

const NOT_RUN: ToolResultBlock['content'] = [
  { type: 'text', text: 'interrupted: the tool call did not complete' },
];

function pairToolResults(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') continue; // emitted right after its assistant message
    out.push(m);
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b) => b.type === 'tool_use');
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    const given = new Map<string, ToolResultBlock>();
    if (next?.role === 'tool') {
      for (const b of next.content) if (b.type === 'tool_result') given.set(b.toolUseId, b);
    }
    out.push({
      ...(next?.role === 'tool' ? next : m),
      role: 'tool',
      content: uses.map(
        (u) =>
          given.get(u.id) ?? {
            type: 'tool_result',
            toolUseId: u.id,
            content: NOT_RUN,
            isError: true,
          },
      ),
    });
  }
  return out;
}

/** A message the tool loop builds in memory (never stored by the runner). */
export function loopMessage(conversationId: string, role: MessageRole, content: Block[]): Message {
  return {
    id: `loop-${Math.random().toString(36).slice(2)}`,
    conversationId,
    role,
    content,
    status: 'complete',
    seq: 0,
    createdAt: new Date().toISOString(),
    error: null,
  };
}
