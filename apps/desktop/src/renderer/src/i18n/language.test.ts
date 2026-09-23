import { describe, expect, it } from 'vitest';
import { resolveLanguage } from './language';

describe('resolveLanguage', () => {
  it('follows the system for Portuguese, English otherwise, unless the user chose', () => {
    expect(resolveLanguage('system', 'pt-BR')).toBe('pt-BR');
    expect(resolveLanguage('system', 'pt-PT')).toBe('pt-BR');
    expect(resolveLanguage('system', 'de-DE')).toBe('en');
    expect(resolveLanguage('en', 'pt-BR')).toBe('en');
    expect(resolveLanguage('pt-BR', 'en-US')).toBe('pt-BR');
  });
});
