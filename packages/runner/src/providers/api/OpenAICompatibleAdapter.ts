import OpenAI from 'openai';
import {
  AppError,
  providerDescriptors,
  type Connection,
  type ModelInfo,
  type StopReason,
  type TestResult,
} from '@comitiva/contract';
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';
import {
  UsageTracker,
  httpError,
  networkError,
  plainText,
  probe,
  streamTurn,
  withDeadline,
} from './shared.js';

type OpenAICompatibleConnection = Extract<Connection, { provider: 'openai-compatible' }>;

/**
 * Chat Completions adapter for any OpenAI-compatible endpoint: OpenAI,
 * OpenRouter, Groq, LM Studio, vLLM… The key is optional (local servers).
 * Text only for now; tools and images arrive in later phases.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id = 'openai-compatible' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors['openai-compatible'].capabilities;

  testConnection(connection: Connection, secret?: string): Promise<TestResult> {
    return probe(
      (signal) => this.client(connection, secret, 0).models.list({ signal }),
      toAppError,
    );
  }

  listModels(connection: Connection, secret?: string): Promise<ModelInfo[]> {
    return withDeadline(async (signal) => {
      const models: ModelInfo[] = [];
      for await (const m of this.client(connection, secret, 0).models.list({ signal })) {
        models.push(toModelInfo(m as unknown as Record<string, unknown>));
      }
      return models;
    }, toAppError);
  }

  run(input: RunInput, _ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    const conn = asConnection(input.connection);
    return streamTurn({
      signal,
      usage,
      toAppError,
      body: async function* (
        this: OpenAICompatibleAdapter,
      ): AsyncGenerator<AdapterEvent, StopReason> {
        const params: OpenAI.ChatCompletionCreateParamsStreaming = {
          model: input.model,
          messages: toProviderMessages(input),
          stream: true,
          // Without this, most servers never report usage for streamed responses.
          stream_options: { include_usage: true },
        };
        if (input.params.maxTokens !== undefined) {
          // OpenAI's own reasoning models reject `max_tokens`; other servers expect it.
          if (conn.config.preset === 'openai')
            params.max_completion_tokens = input.params.maxTokens;
          else params.max_tokens = input.params.maxTokens;
        }
        if (input.params.temperature !== undefined) params.temperature = input.params.temperature;
        if (input.params.topP !== undefined) params.top_p = input.params.topP;

        let stopReason: StopReason = 'other';
        const stream = await this.client(conn, input.secret).chat.completions.create(params, {
          signal,
        });
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const text = choice?.delta?.content;
          if (text) yield { type: 'run.text_delta', text };
          if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
          if (chunk.usage) {
            usage.report({
              input: chunk.usage.prompt_tokens,
              output: chunk.usage.completion_tokens,
              cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
              final: true,
            });
          }
        }
        return stopReason;
      }.bind(this),
    });
  }

  /** `maxRetries` 0 for probes (fast feedback); the SDK default (2) for runs. */
  private client(connection: Connection, secret: string | undefined, maxRetries?: number): OpenAI {
    const conn = asConnection(connection);
    // Every credential and endpoint is explicit: the SDK would otherwise read
    // OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID… from the environment.
    return new OpenAI({
      apiKey: secret ?? 'unused',
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: conn.config.baseUrl,
      // Keyless servers (LM Studio, local vLLM): send no Authorization header at all.
      ...(secret ? {} : { defaultHeaders: { Authorization: null } }),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    });
  }
}

function asConnection(connection: Connection): OpenAICompatibleConnection {
  if (connection.provider !== 'openai-compatible') {
    throw new AppError(
      'invalid_request',
      `OpenAICompatibleAdapter cannot handle ${connection.provider}`,
    );
  }
  return connection;
}

export function toProviderMessages(input: RunInput): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (input.system !== '') messages.push({ role: 'system', content: input.system });
  for (const m of input.messages) {
    const content = plainText(m, 'OpenAI-compatible connections');
    messages.push(
      m.role === 'assistant' ? { role: 'assistant', content } : { role: 'user', content },
    );
  }
  return messages;
}

/** OpenRouter adds `name`/`context_length`, Groq adds `context_window`. */
function toModelInfo(m: Record<string, unknown>): ModelInfo {
  const context = m.context_length ?? m.context_window;
  return {
    id: String(m.id),
    ...(typeof m.name === 'string' && m.name !== '' ? { name: m.name } : {}),
    ...(typeof context === 'number' && Number.isInteger(context) && context > 0
      ? { contextWindow: context }
      : {}),
  };
}

export function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AppError('timeout', err.message, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError) return networkError(err);
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    return httpError(err.status, err.message, err);
  }
  // Some servers send an error object inside the stream instead of an HTTP status.
  if (err instanceof OpenAI.APIError) return new AppError('provider_error', err.message);
  return AppError.from(err);
}
