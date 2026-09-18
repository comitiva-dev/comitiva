import Anthropic from '@anthropic-ai/sdk';
import {
  AppError,
  providerDescriptors,
  type Block,
  type Connection,
  type Message,
  type ModelInfo,
  type StopReason,
  type TestResult,
  type ToolResultContentBlock,
} from '@comitiva/contract';
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';
import {
  UsageTracker,
  httpError,
  networkError,
  probe,
  streamTurn,
  withDeadline,
} from './shared.js';

const DEFAULT_MAX_TOKENS = 16_000;

type AnthropicConnection = Extract<Connection, { provider: 'anthropic' }>;

/**
 * Anthropic Messages API adapter. Streams text; the tool loop
 * (runs/ToolLoop.ts) arrives in Phase 5.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.anthropic.capabilities;

  testConnection(connection: Connection, secret?: string): Promise<TestResult> {
    return probe(
      (signal) => this.client(connection, secret, 0).models.list({ limit: 1 }, { signal }),
      toAppError,
    );
  }

  listModels(connection: Connection, secret?: string): Promise<ModelInfo[]> {
    return withDeadline(async (signal) => {
      const models: ModelInfo[] = [];
      for await (const m of this.client(connection, secret, 0).models.list(
        { limit: 1000 },
        { signal },
      )) {
        models.push({
          id: m.id,
          name: m.display_name,
          ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}),
        });
      }
      return models;
    }, toAppError);
  }

  run(input: RunInput, _ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal,
      usage,
      toAppError,
      body: async function* (this: AnthropicAdapter): AsyncGenerator<AdapterEvent, StopReason> {
        const params: Anthropic.MessageCreateParamsStreaming = {
          model: input.model,
          max_tokens: input.params.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: toProviderMessages(input.messages),
          stream: true,
        };
        if (input.system !== '') params.system = input.system;
        if (input.params.temperature !== undefined) params.temperature = input.params.temperature;
        if (input.params.topP !== undefined) params.top_p = input.params.topP;

        let stopReason: StopReason = 'other';
        const stream = this.client(input.connection, input.secret).messages.stream(params, {
          signal,
        });
        for await (const event of stream) {
          switch (event.type) {
            case 'message_start': {
              const u = event.message.usage;
              usage.report({
                input: u.input_tokens,
                output: u.output_tokens,
                cacheRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
              });
              break;
            }
            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                yield { type: 'run.text_delta', text: event.delta.text };
              }
              break;
            case 'message_delta':
              // Output tokens are only final in message_delta.
              usage.report({ output: event.usage.output_tokens, final: true });
              if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
              break;
            default:
              break;
          }
        }
        return stopReason;
      }.bind(this),
    });
  }

  /** `maxRetries` 0 for probes (fast feedback); the SDK default (2) for runs. */
  private client(
    connection: Connection,
    secret: string | undefined,
    maxRetries?: number,
  ): Anthropic {
    if (connection.provider !== 'anthropic') {
      throw new AppError(
        'invalid_request',
        `AnthropicAdapter cannot handle ${connection.provider}`,
      );
    }
    if (!secret) throw new AppError('secret_missing', 'An API key is required for Anthropic');
    const config = (connection as AnthropicConnection).config;
    // apiKey is always explicit: the runner never falls back to ambient env credentials.
    return new Anthropic({
      apiKey: secret,
      authToken: null,
      baseURL: config.baseUrl ?? providerDescriptors.anthropic.baseUrl.default,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    });
  }
}

export function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
    case 'pause_turn':
      return reason;
    default:
      return 'other';
  }
}

/** Maps SDK errors to stable AppError codes. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Timeout is a subclass of connection error: check it first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError('timeout', err.message, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) return networkError(err);
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return httpError(err.status, err.message, err);
  }
  return AppError.from(err);
}

// ------------------------------------------------------------ translation

export function toProviderMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    // Canonical `tool` messages carry tool_result blocks, which Anthropic expects in a user turn.
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content.map(toProviderBlock),
  }));
}

function toProviderBlock(block: Block): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content: block.content.map(toToolResultContent),
      };
    case 'image':
    case 'document':
      return toToolResultContent(block) as Anthropic.ContentBlockParam;
  }
}

function toToolResultContent(
  block: ToolResultContentBlock,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.source.kind !== 'base64') {
    // File sources are resolved by the shell before a run (later phase).
    throw new AppError(
      'unsupported_content',
      `${block.type} blocks with file sources are not supported yet`,
    );
  }
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.source.mediaType as Anthropic.Base64ImageSource['media_type'],
        data: block.source.data,
      },
    };
  }
  if (block.mediaType !== 'application/pdf') {
    throw new AppError(
      'unsupported_content',
      `document type ${block.mediaType} is not supported yet`,
    );
  }
  return {
    type: 'document',
    title: block.name,
    source: { type: 'base64', media_type: 'application/pdf', data: block.source.data },
  };
}
