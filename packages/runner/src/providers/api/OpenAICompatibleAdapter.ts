import OpenAI from 'openai';
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
import type { AdapterEvent, ProviderAdapter, RunContext, RunInput } from '../ProviderAdapter.js';
import {
  UsageTracker,
  httpError,
  networkError,
  parseJson,
  plainText,
  probe,
  streamTurn,
  toolResultText,
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

  /** One Chat Completions call: text deltas, then the complete tool calls. */
  private async *stream(
    input: RunInput,
    messages: Message[],
    tools: ToolDef[],
    usage: UsageTracker,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent, StopReason> {
    const conn = asConnection(input.connection);
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: input.model,
      messages: toProviderMessages(input.system, messages),
      stream: true,
      // Without this, most servers never report usage for streamed responses.
      stream_options: { include_usage: true },
    };
    if (input.params.maxTokens !== undefined) {
      // OpenAI's own reasoning models reject `max_tokens`; other servers expect it.
      if (conn.config.preset === 'openai') params.max_completion_tokens = input.params.maxTokens;
      else params.max_tokens = input.params.maxTokens;
    }
    if (input.params.temperature !== undefined) params.temperature = input.params.temperature;
    if (input.params.topP !== undefined) params.top_p = input.params.topP;
    if (tools.length > 0) params.tools = tools.map(toProviderTool);

    let stopReason: StopReason = 'other';
    // Tool calls stream as fragments keyed by index: id and name first, then arguments.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const stream = await this.client(conn, input.secret).chat.completions.create(params, {
      signal,
    });
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const text = choice?.delta?.content;
      if (text) yield { type: 'run.text_delta', text };
      for (const call of choice?.delta?.tool_calls ?? []) {
        const c = calls.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id) c.id = call.id;
        if (call.function?.name) c.name += call.function.name;
        if (call.function?.arguments) c.args += call.function.arguments;
        calls.set(call.index, c);
      }
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
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'run.block',
        block: {
          type: 'tool_use',
          // Some servers omit ids; the loop needs one to pair the result.
          id: c.id || `call_${index}_${Date.now().toString(36)}`,
          toolServerId: '',
          name: c.name,
          input: parseJson(c.args),
        },
      };
    }
    return stopReason;
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

export function toProviderMessages(
  system: string,
  messages: readonly Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (system !== '') out.push({ role: 'system', content: system });
  const where = 'OpenAI-compatible connections';
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: plainText(m.content, where) });
    } else if (m.role === 'assistant') {
      const text = plainText(
        m.content.filter((b) => b.type !== 'tool_use'),
        where,
      );
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({
        role: 'assistant',
        content: text === '' && calls.length > 0 ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: toolResultText(b) });
        }
      }
    }
  }
  return out;
}

function toProviderTool(tool: ToolDef): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: { type: 'object', ...tool.inputSchema },
    },
  };
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
