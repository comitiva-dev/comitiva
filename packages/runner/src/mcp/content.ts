import type { ToolDef, ToolResultContentBlock } from '@comitiva/contract';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../providers/ProviderAdapter.js';

/** Text beyond this (per result) is cut: a runaway tool must not fill the model's context. */
export const MAX_RESULT_CHARS = 100_000;

/** The parts of an MCP tool definition the runner keeps. */
export function toToolDef(tool: Tool): ToolDef {
  const a = tool.annotations;
  const annotations = {
    ...(a?.readOnlyHint !== undefined ? { readOnlyHint: a.readOnlyHint } : {}),
    ...(a?.destructiveHint !== undefined ? { destructiveHint: a.destructiveHint } : {}),
    ...(a?.idempotentHint !== undefined ? { idempotentHint: a.idempotentHint } : {}),
    ...(a?.openWorldHint !== undefined ? { openWorldHint: a.openWorldHint } : {}),
  };
  const title = tool.title ?? a?.title;
  return {
    name: tool.name,
    ...(title ? { title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

/** An MCP tool result in canonical blocks (text, image); other content becomes a text note. */
export function toToolResult(result: CallToolResult): ToolResult {
  const content: ToolResultContentBlock[] = [];
  let budget = MAX_RESULT_CHARS;
  const pushText = (text: string) => {
    if (budget <= 0) return;
    const cut = text.length > budget;
    content.push({
      type: 'text',
      text: cut ? `${text.slice(0, budget)}\n[output truncated]` : text,
    });
    budget -= text.length;
  };
  for (const item of result.content ?? []) {
    switch (item.type) {
      case 'text':
        pushText(item.text);
        break;
      case 'image':
        content.push({
          type: 'image',
          source: { kind: 'base64', mediaType: item.mimeType, data: item.data },
        });
        break;
      case 'resource':
        pushText(
          'text' in item.resource
            ? item.resource.text
            : `[binary resource ${item.resource.uri} not shown]`,
        );
        break;
      case 'resource_link':
        pushText(`[resource: ${item.uri}${item.name ? ` (${item.name})` : ''}]`);
        break;
      default:
        pushText(`[${item.type} content not shown]`);
    }
  }
  if (content.length === 0 && result.structuredContent !== undefined) {
    pushText(JSON.stringify(result.structuredContent));
  }
  if (content.length === 0) pushText('(no output)');
  return { content, isError: result.isError === true };
}

/** A failure the model sees as a tool result: the stable code first, like the built-in servers. */
export function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}
