import type {
  Block,
  Conversation,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '@comitiva/contract';

export interface MarkdownSource {
  conversation: Pick<Conversation, 'title' | 'createdAt'>;
  agentName: string;
  /** "Anthropic · claude-sonnet-5", or null when the connection is gone. */
  model: string | null;
  messages: readonly Message[];
  exportedAt: string;
}

/** A code fence longer than any run of backticks inside `text`. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function toolResultText(result: ToolResultBlock): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : `[${c.name}]`))
    .join('\n');
}

function toolBlock(use: ToolUseBlock, result: ToolResultBlock | undefined): string {
  const state = !result ? 'no result' : result.isError ? 'failed' : 'done';
  const duration = result?.durationMs !== undefined ? `, ${result.durationMs} ms` : '';
  const input = JSON.stringify(use.input ?? {}, null, 2);
  const lines = [
    `<details>`,
    `<summary>Tool <code>${use.name}</code> (${state}${duration})</summary>`,
    '',
    '**Input**',
    '',
    fence(input, 'json'),
  ];
  if (result) lines.push('', '**Result**', '', fence(toolResultText(result)));
  lines.push('', '</details>');
  return lines.join('\n');
}

function attachment(block: Extract<Block, { type: 'image' | 'document' }>): string {
  const name = block.type === 'document' ? block.name : (block.name ?? 'image');
  return `> 📎 Attachment: ${name}${block.type === 'image' ? ' (image)' : ''}`;
}

function body(content: readonly Block[]): string {
  const results = new Map<string, ToolResultBlock>();
  for (const b of content) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text.trim() !== '') parts.push(b.text.trim());
    } else if (b.type === 'image' || b.type === 'document') parts.push(attachment(b));
    else if (b.type === 'tool_use') parts.push(toolBlock(b, results.get(b.id)));
  }
  return parts.join('\n\n');
}

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

/**
 * A conversation as Markdown: a header with the agent and model, then each
 * message under its author and time. Tool calls are `<details>` blocks with
 * their input and result; attachments are named, not embedded. Tool-role
 * messages carry only results, shown with their calls, so they add no section.
 */
export function conversationMarkdown(src: MarkdownSource): string {
  const title = src.conversation.title ?? 'Untitled conversation';
  const out = [
    `# ${title}`,
    '',
    `- Agent: ${src.agentName}`,
    ...(src.model ? [`- Model: ${src.model}`] : []),
    `- Started: ${stamp(src.conversation.createdAt)}`,
    `- Exported from Comitiva: ${stamp(src.exportedAt)}`,
  ];
  for (const m of src.messages) {
    if (m.role === 'tool') continue;
    const author = m.role === 'user' ? 'You' : src.agentName;
    const parts = [body(m.content)];
    if (m.status === 'cancelled') parts.push('_Stopped._');
    if (m.status === 'error') parts.push(`_Failed: ${m.error?.code ?? 'error'}._`);
    if (m.status === 'streaming') parts.push('_Still responding when exported._');
    out.push('', '---', '', `### ${author} · ${stamp(m.createdAt)}`, '');
    out.push(parts.filter((p) => p !== '').join('\n\n'));
  }
  return `${out.join('\n')}\n`;
}
