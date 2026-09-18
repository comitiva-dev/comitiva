import { ApiError, FinishReason, GoogleGenAI, type Content } from '@google/genai';
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
  isFetchFailure,
  networkError,
  plainText,
  probe,
  streamTurn,
  withDeadline,
} from './shared.js';

type GoogleConnection = Extract<Connection, { provider: 'google' }>;

/**
 * Gemini API adapter (Google AI Studio keys; Vertex AI is not supported).
 * Text only for now; tools and images arrive in later phases.
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

  run(input: RunInput, _ctx: RunContext, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const usage = UsageTracker.for(input);
    return streamTurn({
      signal,
      usage,
      toAppError,
      body: async function* (this: GoogleAdapter): AsyncGenerator<AdapterEvent, StopReason> {
        const stream = await this.client(
          input.connection,
          input.secret,
        ).models.generateContentStream({
          model: input.model,
          contents: toProviderContents(input),
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
          },
        });
        let stopReason: StopReason = 'other';
        for await (const chunk of stream) {
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            // Thought summaries are not part of the answer.
            if (part.text && !part.thought) yield { type: 'run.text_delta', text: part.text };
          }
          if (candidate?.finishReason) stopReason = mapStopReason(candidate.finishReason);
          const u = chunk.usageMetadata;
          if (u) {
            usage.report({
              input: u.promptTokenCount,
              // Thinking tokens are billed as output.
              output:
                u.candidatesTokenCount !== undefined || u.thoughtsTokenCount !== undefined
                  ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
                  : undefined,
              cacheRead: u.cachedContentTokenCount,
              // Usage is cumulative per chunk; it is complete once the candidate finishes.
              final: candidate?.finishReason !== undefined,
            });
          }
        }
        return stopReason;
      }.bind(this),
    });
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

export function toProviderContents(input: RunInput): Content[] {
  return input.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: plainText(m, 'Gemini connections') }],
  }));
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
