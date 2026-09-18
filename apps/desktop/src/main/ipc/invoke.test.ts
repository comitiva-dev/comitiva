import { describe, expect, it } from 'vitest';
import { AppError } from '@comitiva/contract';
import { runInvoke } from './invoke';

const now = '2026-09-18T12:00:00.000Z';
const connection = {
  id: 'c1',
  name: 'Anthropic',
  kind: 'api' as const,
  provider: 'anthropic' as const,
  config: {},
  secretRef: 'connection:c1',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

describe('runInvoke', () => {
  it('rejects invalid input with invalid_request', async () => {
    const r = await runInvoke('connections.update', { id: 'c1' }, async () => {
      throw new Error('must not run');
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('passes validated input and returns the value', async () => {
    const r = await runInvoke('app.getVersion', undefined, () => '0.1.0');
    expect(r).toEqual({ ok: true, value: '0.1.0' });
  });

  it('never lets a key reach the renderer, even if a handler leaks one', async () => {
    const leaky = [
      {
        connection: { ...connection, apiKey: 'sk-secret' },
        hasSecret: true,
        lastTest: null,
        secret: 'sk-secret',
      },
    ];
    const r = await runInvoke('connections.list', undefined, async () => leaky as never);
    expect(r).toEqual({ ok: true, value: [{ connection, hasSecret: true, lastTest: null }] });
    expect(JSON.stringify(r)).not.toContain('sk-secret');
  });

  it('carries AppError codes across', async () => {
    const r = await runInvoke('connections.delete', { id: 'c1' }, async () => {
      throw new AppError('connection_in_use', 'used by agents');
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'connection_in_use', message: 'used by agents', retryable: false },
    });
  });
});
