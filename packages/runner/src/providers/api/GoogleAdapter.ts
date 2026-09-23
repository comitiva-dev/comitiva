import { ApiError, FinishReason, GoogleGenAI, type Content, type Part } from '@google/genai';
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
  withDeadline,
} from './shared.js';

type GoogleConnection = Extract<Connection, { provider: 'google' }>;

/**
 * Gemini API adapter (Google AI Studio keys; Vertex AI is not supported).
 * Text and function calling; images arrive in a later phase.
 */
export class GoogleAdapter implements ProviderAdapter {
  readonly id = 'google' as const;
  readonly kind = 'api' as const;
  readonly capabilities = providerDescriptors.google.capabilities;

  testConnection(connection: Connection, secret?: string): Promise<TestResult> {
    return probe(
      (signal) =>
        this.client(connection, secret).models.list({
          config: { pageSize: 1, abortSignal: signal },
        }),
      toAppError,
    );
  }

  listModels(connection: Connection, secret?: string): Promise<ModelInfo[]> {
    return withDeadline(async (signal) => {
      const pager = await this.client(connection, secret).models.list({
        config: { pageSize: 1000, abortSignal: signal },
      });
      const models: ModelInfo[] = [];
      for await (const m of pager) {
        // Only chat models: embeddings and others do not support generateContent.
        if (m.supportedActions && !m.supportedActions.includes('generateContent')) continue;
        if (!m.name) continue;
        models.push({
          id: m.name.replace(/^models\//, ''),
          ...(m.displayName ? { name: m.displayName } : {}),
          ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}),
        });
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

  /** One generateContentStream call: text deltas and function calls (complete per part). */
  private async *stream(
    input: RunInput,
    messages: Message[],
    tools: ToolDef[],
    usage: UsageTracker,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent, StopReason> {
    const stream = await this.client(input.connection, input.secret).models.generateContentStream({
      model: input.model,
      contents: toProviderContents(messages),
      config: {
        abortSignal: signal,
        ...(input.system !== '' ? { systemInstruction: input.system } : {}),
        ...(input.params.temperature !== undefined
          ? { temperature: input.params.temperature }
          : {}),
        ...(input.params.topP !== undefined ? { topP: input.params.topP } : {}),
        ...(input.params.maxTokens !== undefined
          ? { maxOutputTokens: input.params.maxTokens }
          : {}),
        ...(tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    ...(t.description ? { description: t.description } : {}),
                    parametersJsonSchema: t.inputSchema,
                  })),
                },
              ],
            }
          : {}),
      },
    });
    let stopReason: StopReason = 'other';
    let calls = 0;
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        // Thought summaries are not part of the answer.
        if (part.text && !part.thought) yield { type: 'run.text_delta', text: part.text };
        const fc = part.functionCall;
        if (fc?.name) {
          yield {
            type: 'run.block',
            block: {
              type: 'tool_use',
              // The Gemini API usually omits ids; responses are matched by name and order.
              id: fc.id ?? `gemini_${calls}_${Date.now().toString(36)}`,
              toolServerId: '',
              name: fc.name,
              input: fc.args ?? {},
              ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
            },
          };
          calls++;
        }
      }
      if (candidate?.finishReason) stopReason = mapStopReason(candidate.finishReason);
      const u = chunk.usageMetadata;
      if (u) {
        usage.report({
          // `promptTokenCount` counts the cached tokens too; the contract
          // wants input net of them (they are priced at the cache rate).
          input:
            u.promptTokenCount === undefined
              ? undefined
              : Math.max(0, u.promptTokenCount - (u.cachedContentTokenCount ?? 0)),
          // Thinking tokens are billed as output.
          output:
            u.candidatesTokenCount !== undefined || u.thoughtsTokenCount !== undefined
              ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
              : undefined,
          cacheRead: u.cachedContentTokenCount,
          model: chunk.modelVersion,
          // Usage is cumulative per chunk; it is complete once the candidate finishes.
          final: candidate?.finishReason !== undefined,
        });
      }
    }
    return stopReason;
  }

  private client(connection: Connection, secret: string | undefined): GoogleGenAI {
    if (connection.provider !== 'google') {
      throw new AppError('invalid_request', `GoogleAdapter cannot handle ${connection.provider}`);
    }
    if (!secret) throw new AppError('secret_missing', 'An API key is required for Gemini');
    const config = (connection as GoogleConnection).config;
    // Explicit key and backend: the SDK would otherwise read GEMINI_API_KEY /
    // GOOGLE_API_KEY / GOOGLE_GENAI_USE_VERTEXAI from the environment.
    return new GoogleGenAI({
      apiKey: secret,
      vertexai: false,
      httpOptions: { baseUrl: config.baseUrl ?? providerDescriptors.google.baseUrl.default },
    });
  }
}

export function toProviderContents(messages: readonly Message[]): Content[] {
  // functionResponse needs the call's name; tool results only carry the id.
  const names = new Map<string, string>();
  const where = 'Gemini connections';
  return messages.map((m): Content => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.content.flatMap((b): Part[] => {
          if (b.type !== 'tool_result') return [];
          const text = toolResultText(b);
          return [
            {
              functionResponse: {
                ...(b.toolUseId.startsWith('gemini_') ? {} : { id: b.toolUseId }),
                name: names.get(b.toolUseId) ?? 'unknown',
                response: b.isError ? { error: text } : { output: text },
              },
            },
          ];
        }),
      };
    }
    if (m.role === 'assistant') {
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          parts.push({
            functionCall: {
              ...(b.id.startsWith('gemini_') ? {} : { id: b.id }),
              name: b.name,
              args: (b.input ?? {}) as Record<string, unknown>,
            },
            ...(b.signature ? { thoughtSignature: b.signature } : {}),
          });
        } else parts.push({ text: plainText([b], where) });
      }
      return { role: 'model', parts };
    }
    return {
      role: 'user',
      parts: userParts(m.content, { images: true, provider: where }).map((p): Part =>
        p.kind === 'text'
          ? { text: p.text }
          : { inlineData: { mimeType: p.mediaType, data: p.data } },
      ),
    };
  });
}

export function mapStopReason(reason: FinishReason | string): StopReason {
  switch (reason) {
    case FinishReason.STOP:
      return 'end_turn';
    case FinishReason.MAX_TOKENS:
      return 'max_tokens';
    case FinishReason.SAFETY:
    case FinishReason.RECITATION:
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
      return 'refusal';
    default:
      return 'other';
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ApiError) {
    // Gemini answers an invalid key with 400 INVALID_ARGUMENT / API_KEY_INVALID.
    if (err.status === 400 && /API_KEY_INVALID|API key not valid/i.test(err.message)) {
      return new AppError('auth_failed', err.message, { retryable: false, cause: err });
    }
    return httpError(err.status, err.message, err);
  }
  // fetch failures (refused, DNS, reset) surface as TypeError('fetch failed').
  if (isFetchFailure(err) || (err instanceof Error && err.name === 'TimeoutError')) {
    return networkError(err);
  }
  return AppError.from(err);
}
