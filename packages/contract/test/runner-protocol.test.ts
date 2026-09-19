import { describe, expect, it } from 'vitest';
import { AppError, RunnerEvent, RunnerRequest, isRunEvent } from '../src/index.js';
import { agent, anthropicConnection, userMessage } from './fixtures.js';

describe('RunnerRequest', () => {
  it('parses run.start', () => {
    const req = {
      id: '1',
      type: 'run.start',
      runId: 'r1',
      conversationId: userMessage.conversationId,
      agent,
      connection: anthropicConnection,
      secret: 'sk-test',
      messages: [userMessage],
    };
    expect(RunnerRequest.parse(req)).toMatchObject({ type: 'run.start', runId: 'r1' });
  });

  it('parses cli.detect', () => {
    expect(
      RunnerRequest.safeParse({ id: '1', type: 'cli.detect', provider: 'codex' }).success,
    ).toBe(true);
    expect(RunnerRequest.safeParse({ id: '1', type: 'cli.detect' }).success).toBe(false);
  });

  it('parses ping, cancel and shutdown', () => {
    for (const r of [
      { id: '1', type: 'ping' },
      { id: '2', type: 'run.cancel', runId: 'r1' },
      { id: '3', type: 'shutdown' },
    ]) {
      expect(RunnerRequest.safeParse(r).success).toBe(true);
    }
  });

  it('rejects requests without id or with unknown type', () => {
    expect(RunnerRequest.safeParse({ type: 'ping' }).success).toBe(false);
    expect(RunnerRequest.safeParse({ id: '1', type: 'explode' }).success).toBe(false);
  });
});

describe('RunnerEvent', () => {
  it('parses responses and run events', () => {
    const events: unknown[] = [
      { type: 'response', id: '1', ok: true, result: { version: '0.1.0' } },
      {
        type: 'response',
        id: '1',
        ok: false,
        error: { code: 'auth_failed', message: 'x', retryable: false },
      },
      { type: 'run.text_delta', runId: 'r1', text: 'Hel', ts: 1758196800000.25 },
      { type: 'run.usage', runId: 'r1', inputTokens: 10, outputTokens: 3, estimated: false },
      { type: 'run.done', runId: 'r1', stopReason: 'cancelled' },
      {
        type: 'run.error',
        runId: 'r1',
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
      },
      { type: 'log', level: 'info', message: 'hi' },
    ];
    for (const e of events) expect(RunnerEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  it('distinguishes run events', () => {
    const e = RunnerEvent.parse({ type: 'run.done', runId: 'r1', stopReason: 'end_turn' });
    expect(isRunEvent(e)).toBe(true);
    expect(isRunEvent(RunnerEvent.parse({ type: 'log', level: 'info', message: '' }))).toBe(false);
  });
});

describe('AppError', () => {
  it('round-trips through its wire shape', () => {
    const err = new AppError('rate_limited', 'Too many requests', { retryable: true });
    const back = AppError.fromShape(JSON.parse(JSON.stringify(err)));
    expect(back).toBeInstanceOf(AppError);
    expect(back.toJSON()).toEqual({
      code: 'rate_limited',
      message: 'Too many requests',
      retryable: true,
    });
  });

  it('normalizes unknown errors to internal', () => {
    expect(AppError.from(new Error('boom')).code).toBe('internal');
    expect(AppError.from('boom').message).toBe('boom');
  });
});
