import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import {
  AppError,
  type Agent,
  type Connection,
  type Message,
  type RunEvent,
  type SpikeEvent,
  type TestResult,
} from '@comitiva/contract';
import type { RunnerClient } from '@comitiva/runner';
import type { SecretStore } from '../secrets/SecretStore';

/**
 * Phase 0 spike: two in-memory conversations against one Anthropic key.
 * Replaced by ConversationService (persistence, agents) in Phase 4.
 */

export const SPIKE_SECRET_REF = 'spike:anthropic';
export const SPIKE_DEFAULT_MODEL = 'claude-haiku-4-5';
/** Deltas are coalesced per conversation and forwarded once per frame. */
export const DELTA_FLUSH_MS = 16;

type RunnerPort = Pick<RunnerClient, 'startRun' | 'cancelRun' | 'testConnection' | 'on'>;

export interface SpikeServiceDeps {
  runner: RunnerPort;
  secrets: SecretStore;
  emit: (event: SpikeEvent) => void;
  latencyLogFile: string;
  /** Test/e2e override for the Anthropic endpoint. */
  anthropicBaseUrl?: string | undefined;
  flushMs?: number;
}

interface ConversationState {
  history: Message[];
  runId: string | null;
  assistantText: string;
  pendingText: string;
  pendingSince: number | undefined;
  flushTimer: NodeJS.Timeout | null;
}

export class SpikeService {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly runToConversation = new Map<string, string>();
  private readonly flushMs: number;

  constructor(private readonly deps: SpikeServiceDeps) {
    this.flushMs = deps.flushMs ?? DELTA_FLUSH_MS;
    deps.runner.on('run.event', (e) => this.handleRunEvent(e));
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await this.deps.secrets.set(SPIKE_SECRET_REF, apiKey.trim());
  }

  hasApiKey(): Promise<boolean> {
    return this.deps.secrets.has(SPIKE_SECRET_REF);
  }

  async testApiKey(): Promise<TestResult> {
    const secret = await this.requireSecret();
    return this.deps.runner.testConnection({
      type: 'connection.test',
      connection: this.connection(),
      secret,
    });
  }

  async send(conversationId: string, text: string, model: string): Promise<void> {
    const conv = this.state(conversationId);
    if (conv.runId) throw new AppError('invalid_request', 'This conversation is already running');
    const secret = await this.requireSecret();

    conv.history.push(this.message(conversationId, 'user', text));
    conv.assistantText = '';
    const { runId } = this.deps.runner.startRun({
      conversationId,
      agent: this.agent(model),
      connection: this.connection(),
      secret,
      messages: conv.history,
    });
    conv.runId = runId;
    this.runToConversation.set(runId, conversationId);
  }

  cancel(conversationId: string): void {
    const runId = this.conversations.get(conversationId)?.runId;
    if (runId) this.deps.runner.cancelRun(runId);
  }

  reset(conversationId: string): void {
    this.cancel(conversationId);
    const conv = this.state(conversationId);
    conv.history = [];
  }

  async reportLatency(conversationId: string, samplesMs: number[]): Promise<void> {
    if (samplesMs.length === 0) return;
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const line = {
      at: new Date().toISOString(),
      conversationId,
      flushMs: this.flushMs,
      n: sorted.length,
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted.at(-1)!),
      samplesMs: sorted.map(round),
    };
    await mkdir(dirname(this.deps.latencyLogFile), { recursive: true });
    await appendFile(this.deps.latencyLogFile, `${JSON.stringify(line)}\n`);
  }

  private handleRunEvent(e: RunEvent): void {
    const conversationId = this.runToConversation.get(e.runId);
    if (!conversationId) return;
    const conv = this.state(conversationId);

    switch (e.type) {
      case 'run.text_delta':
        conv.assistantText += e.text;
        conv.pendingText += e.text;
        conv.pendingSince ??= e.ts;
        conv.flushTimer ??= setTimeout(() => this.flush(conversationId), this.flushMs);
        break;
      case 'run.usage':
        this.flush(conversationId);
        this.deps.emit({
          kind: 'usage',
          conversationId,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
        });
        break;
      case 'run.done':
        this.flush(conversationId);
        this.finish(
          conversationId,
          e.runId,
          e.stopReason === 'cancelled' ? 'cancelled' : 'complete',
        );
        this.deps.emit({ kind: 'done', conversationId, stopReason: e.stopReason });
        break;
      case 'run.error':
        this.flush(conversationId);
        this.finish(conversationId, e.runId, 'error');
        this.deps.emit({ kind: 'error', conversationId, code: e.code, retryable: e.retryable });
        break;
      default:
        break;
    }
  }

  private flush(conversationId: string): void {
    const conv = this.state(conversationId);
    if (conv.flushTimer) clearTimeout(conv.flushTimer);
    conv.flushTimer = null;
    if (conv.pendingText === '') return;
    this.deps.emit({
      kind: 'delta',
      conversationId,
      text: conv.pendingText,
      ...(conv.pendingSince !== undefined ? { runnerTs: conv.pendingSince } : {}),
    });
    conv.pendingText = '';
    conv.pendingSince = undefined;
  }

  private finish(conversationId: string, runId: string, status: Message['status']): void {
    const conv = this.state(conversationId);
    this.runToConversation.delete(runId);
    if (conv.runId !== runId) return;
    conv.runId = null;
    if (conv.assistantText !== '') {
      conv.history.push({
        ...this.message(conversationId, 'assistant', conv.assistantText),
        status,
      });
    }
  }

  private async requireSecret(): Promise<string> {
    const secret = await this.deps.secrets.get(SPIKE_SECRET_REF);
    if (!secret) throw new AppError('secret_missing', 'Save an Anthropic API key first');
    return secret;
  }

  private state(conversationId: string): ConversationState {
    let conv = this.conversations.get(conversationId);
    if (!conv) {
      conv = {
        history: [],
        runId: null,
        assistantText: '',
        pendingText: '',
        pendingSince: undefined,
        flushTimer: null,
      };
      this.conversations.set(conversationId, conv);
    }
    return conv;
  }

  private message(conversationId: string, role: 'user' | 'assistant', text: string): Message {
    const conv = this.state(conversationId);
    return {
      id: ulid(),
      conversationId,
      role,
      content: [{ type: 'text', text }],
      status: 'complete',
      seq: conv.history.length,
      createdAt: new Date().toISOString(),
    };
  }

  private connection(): Connection {
    const now = new Date().toISOString();
    return {
      id: 'spike-connection',
      name: 'Spike (Anthropic)',
      kind: 'api',
      provider: 'anthropic',
      config: this.deps.anthropicBaseUrl ? { baseUrl: this.deps.anthropicBaseUrl } : {},
      secretRef: SPIKE_SECRET_REF,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private agent(model: string): Agent {
    const now = new Date().toISOString();
    return {
      id: 'spike-agent',
      name: 'Spike',
      avatar: '🧪',
      connectionId: 'spike-connection',
      model,
      role: '',
      params: {},
      toolServerIds: [],
      roots: [],
      permissionPolicy: 'read-only',
      fallbackConnectionIds: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
