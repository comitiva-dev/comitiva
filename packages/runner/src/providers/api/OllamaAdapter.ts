import {
  AppError,
  providerDescriptors,
  type Connection,
  type ModelInfo,
  type StopReason,
  type TestResult,
} from '@comitiva/contract';
import { LineSplitter } from '../../util/jsonl.js';
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';
import {
  UsageTracker,
  httpError,
  isFetchFailure,
  networkError,
  plainText,
  probe,
  streamTurn,
  trimSlash,
  withDeadline,
} from './shared.js';

type OllamaConnection = Extract<Connection, { provider: 'ollama' }>;

interface ChatChunk {
  message?: { content?: string; thinking?: string };
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

  run(input: RunInput, _ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal,
      usage,
      toAppError,
      body: async function* (this: OllamaAdapter): AsyncGenerator<AdapterEvent, StopReason> {
        const options: Record<string, number> = {};
        if (input.params.temperature !== undefined) options.temperature = input.params.temperature;
        if (input.params.topP !== undefined) options.top_p = input.params.topP;
        if (input.params.maxTokens !== undefined) options.num_predict = input.params.maxTokens;

        const res = await this.request(input.connection, input.secret, '/api/chat', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            model: input.model,
            messages: toProviderMessages(input),
            stream: true,
            ...(Object.keys(options).length > 0 ? { options } : {}),
          }),
        });
        if (!res.body) throw new AppError('provider_error', 'Ollama returned an empty body');

        let stopReason: StopReason = 'other';
        for await (const chunk of ndjson(res.body)) {
          if (chunk.error) throw new AppError('provider_error', chunk.error);
          const text = chunk.message?.content;
          if (text) yield { type: 'run.text_delta', text };
          if (chunk.done) {
            stopReason = mapStopReason(chunk.done_reason);
            usage.report({ input: chunk.prompt_eval_count, output: chunk.eval_count, final: true });
          }
        }
        return stopReason;
      }.bind(this),
    });
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

export function toProviderMessages(input: RunInput): Array<{ role: string; content: string }> {
  const messages = input.messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: plainText(m, 'Ollama connections'),
  }));
  return input.system !== '' ? [{ role: 'system', content: input.system }, ...messages] : messages;
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
