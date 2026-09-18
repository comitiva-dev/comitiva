import { describe, expect, it } from 'vitest';
import { AppError } from '@comitiva/contract';
import { runInvoke } from './invoke';

describe('runInvoke', () => {
  it('rejects invalid input with invalid_request', async () => {
    const r = await runInvoke('spike.send', { conversationId: 'a' }, async () => undefined);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('passes validated input and returns the value', async () => {
    const r = await runInvoke('app.getVersion', undefined, () => '0.1.0');
    expect(r).toEqual({ ok: true, value: '0.1.0' });
  });

  it('strips fields that are not in the output schema', async () => {
    const leaky = {
      hasApiKey: true,
      defaultModel: 'm',
      weakSecretStorage: false,
      apiKey: 'sk-secret',
    };
    const r = await runInvoke('spike.getState', undefined, async () => leaky);
    expect(r).toEqual({
      ok: true,
      value: { hasApiKey: true, defaultModel: 'm', weakSecretStorage: false },
    });
  });

  it('carries AppError codes across', async () => {
    const r = await runInvoke('spike.testApiKey', undefined, async () => {
      throw new AppError('secret_missing', 'no key');
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'secret_missing', message: 'no key', retryable: false },
    });
  });
});
