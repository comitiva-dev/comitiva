import {
  AppError,
  providerDescriptors,
  type Connection,
  type Message,
  type ModelInfo,
  type StopReason,
  type TestResult,
  type ToolDef,
} from '@comitiva/contract';
import { toolLoop } from '../../runs/ToolLoop.js';
import { LineSplitter } from '../../util/jsonl.js';
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';
import { userParts } from '../media.js';
import {
  UsageTracker,
  httpError,
  isFetchFailure,
  networkError,
  plainText,
  probe,
  streamTurn,
  toolResultText,
  trimSlash,
  withDeadline,
} from './shared.js';

type OllamaConnection = Extract<Connection, { provider: 'ollama' }>;

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments?: Record<string, unknown> };
}

interface ChatChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Ollama's native API over fetch (`/api/chat` streams NDJSON). The key is
 * optional: plain local Ollama needs none; a proxy or Ollama Cloud takes a
 * bearer token.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.ollama.capabilities;

  testConnection(connection: Connection, secret?: string): Promise<TestResult> {
    return probe(
      (signal) => this.request(connection, secret, '/api/version', { signal }),
      toAppError,
    );
  }

  listModels(connection: Connection, secret?: string): Promise<ModelInfo[]> {
    return withDeadline(async (signal) => {
      const res = await this.request(connection, secret, '/api/tags', { signal });
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      return (body.models ?? []).flatMap((m) => {
        const id = m.model ?? m.name;
        return id ? [{ id, ...(m.name && m.name !== id ? { name: m.name } : {}) }] : [];
      });
    }, toAppError);
  }

  run(input: RunInput, ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal,
      usage,
      toAppError,
      body: () =>
        toolLoop({
          ctx,
          usage,
          messages: input.messages,
          maxIterations: input.params.maxToolIterations,
          call: (messages, tools) => this.stream(input, messages, tools, usage, signal),
        }),
    });
  }

  /** One /api/chat call. Tool calls come whole in a message (and end with done_reason "stop"). */
  private async *stream(
    input: RunInput,
    messages: Message[],
    tools: ToolDef[],
    usage: UsageTracker,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent, StopReason> {
    const options: Record<string, number> = {};
    if (input.params.temperature !== undefined) options.temperature = input.params.temperature;
    if (input.params.topP !== undefined) options.top_p = input.params.topP;
    if (input.params.maxTokens !== undefined) options.num_predict = input.params.maxTokens;

    const res = await this.request(input.connection, input.secret, '/api/chat', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: input.model,
        messages: toProviderMessages(input.system, messages),
        stream: true,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  ...(t.description ? { description: t.description } : {}),
                  parameters: { type: 'object', ...t.inputSchema },
                },
              })),
            }
          : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      }),
    });
    if (!res.body) throw new AppError('provider_error', 'Ollama returned an empty body');

    let stopReason: StopReason = 'other';
    let calls = 0;
    for await (const chunk of ndjson(res.body)) {
      if (chunk.error) throw new AppError('provider_error', chunk.error);
      const text = chunk.message?.content;
      if (text) yield { type: 'run.text_delta', text };
      for (const call of chunk.message?.tool_calls ?? []) {
        yield {
          type: 'run.block',
          block: {
            type: 'tool_use',
            id: call.id ?? `ollama_${calls}_${Date.now().toString(36)}`,
            toolServerId: '',
            name: call.function.name,
            input: call.function.arguments ?? {},
          },
        };
        calls++;
      }
      if (chunk.done) {
        stopReason = mapStopReason(chunk.done_reason);
        usage.report({ input: chunk.prompt_eval_count, output: chunk.eval_count, final: true });
      }
    }
    return stopReason;
  }

  /** fetch with the base URL, optional bearer key and HTTP errors mapped. */
  private async request(
    connection: Connection,
    secret: string | undefined,
    path: string,
    init: RequestInit & { signal: AbortSignal },
  ): Promise<Response> {
    if (connection.provider !== 'ollama') {
      throw new AppError('invalid_request', `OllamaAdapter cannot handle ${connection.provider}`);
    }
    const { baseUrl } = (connection as OllamaConnection).config;
    const res = await fetch(`${trimSlash(baseUrl)}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text || res.statusText;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // not JSON: keep the raw text
      }
      throw httpError(res.status, `Ollama ${res.status}: ${message}`);
    }
    return res;
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const lines: string[] = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  for await (const bytes of body) {
    splitter.push(Buffer.from(bytes));
    while (lines.length > 0) yield JSON.parse(lines.shift()!) as ChatChunk;
  }
  splitter.end();
  while (lines.length > 0) yield JSON.parse(lines.shift()!) as ChatChunk;
}

type OllamaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string; tool_name: string };

export function toProviderMessages(system: string, messages: readonly Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = system !== '' ? [{ role: 'system', content: system }] : [];
  const names = new Map<string, string>();
  const where = 'Ollama connections';
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = userParts(m.content, { images: true, provider: where });
      const images = parts.flatMap((p) => (p.kind === 'image' ? [p.data] : []));
      out.push({
        role: 'user',
        content: parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n'),
        ...(images.length > 0 ? { images } : {}),
      });
    } else if (m.role === 'assistant') {
      const calls: OllamaToolCall[] = [];
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue;
        names.set(b.id, b.name);
        calls.push({
          function: { name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> },
        });
      }
      out.push({
        role: 'assistant',
        content: plainText(
          m.content.filter((b) => b.type !== 'tool_use'),
          where,
        ),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          content: toolResultText(b),
          tool_name: names.get(b.toolUseId) ?? '',
        });
      }
    }
  }
  return out;
}

export function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isFetchFailure(err)) return networkError(err);
  if (err instanceof SyntaxError) {
    return new AppError('provider_error', `Ollama sent malformed data: ${err.message}`);
  }
  return AppError.from(err);
}
