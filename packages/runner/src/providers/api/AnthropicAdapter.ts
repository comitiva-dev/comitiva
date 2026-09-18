import Anthropic from '@anthropic-ai/sdk';
import {
  AppError,
  type Block,
  type Connection,
  type Message,
  type StopReason,
  type TestResult,
  type ToolResultContentBlock,
} from '@comitiva/contract';
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';

const DEFAULT_MAX_TOKENS = 16_000;

type AnthropicConnection = Extract<Connection, { provider: 'anthropic' }>;

/**
 * Anthropic Messages API adapter. Phase 0 streams text only; the tool loop
 * (runs/ToolLoop.ts) arrives in Phase 5.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly kind = 'api' as const;
  readonly capabilities = {
    streaming: true,
    tools: false,
    resume: false,
    listModels: false,
    usage: true,
    images: true,
  };

  async testConnection(connection: Connection, secret?: string): Promise<TestResult> {
    const started = performance.now();
    try {
      await this.client(connection, secret).models.list({ limit: 1 });
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: toAppError(err).toJSON() };
    }
  }

  async *run(input: RunInput, _ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const client = this.client(input.connection, input.secret);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, seen: false };
    let stopReason: StopReason = 'other';

    const usageEvent = (): AdapterEvent => ({
      type: 'run.usage',
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      estimated: false,
    });

    try {
      const params: Anthropic.MessageCreateParamsStreaming = {
        model: input.model,
        max_tokens: input.params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: toProviderMessages(input.messages),
        stream: true,
      };
      if (input.system !== '') params.system = input.system;
      if (input.params.temperature !== undefined) params.temperature = input.params.temperature;
      if (input.params.topP !== undefined) params.top_p = input.params.topP;

      const stream = client.messages.stream(params, { signal });
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            usage.seen = true;
            usage.input = u.input_tokens;
            usage.output = u.output_tokens;
            usage.cacheRead = u.cache_read_input_tokens ?? 0;
            usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
            break;
          }
          case 'content_block_delta':
            if (event.delta.type === 'text_delta')
              yield { type: 'run.text_delta', text: event.delta.text };
            break;
          case 'message_delta':
            usage.output = event.usage.output_tokens;
            if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
        if (usage.seen) yield usageEvent();
        yield { type: 'run.done', stopReason: 'cancelled' };
        return;
      }
      throw toAppError(err);
    }

    yield usageEvent();
    yield { type: 'run.done', stopReason };
  }

  private client(connection: Connection, secret: string | undefined): Anthropic {
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
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
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

/** Maps SDK errors to stable AppError codes, most specific first. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const opts = (retryable: boolean) => ({ retryable, cause: err });
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new AppError('auth_failed', err.message, opts(false));
  }
  if (err instanceof Anthropic.RateLimitError)
    return new AppError('rate_limited', err.message, opts(true));
  if (err instanceof Anthropic.InternalServerError) {
    return new AppError('provider_unavailable', err.message, opts(true));
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AppError('timeout', err.message, opts(true));
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError('provider_unavailable', err.message, opts(true));
  }
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded and other 5xx without a dedicated class.
    if (typeof err.status === 'number' && err.status >= 500) {
      return new AppError('provider_unavailable', err.message, opts(true));
    }
    return new AppError('provider_error', err.message, opts(false));
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
