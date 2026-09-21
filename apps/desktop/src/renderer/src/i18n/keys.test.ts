import { describe, expect, it } from 'vitest';
import en from './en.json';
import ptBR from './pt-BR.json';

const keys = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('i18n', () => {
  it('has the same keys in every language', () => {
    expect(keys(ptBR).sort()).toEqual(keys(en).sort());
  });
});
