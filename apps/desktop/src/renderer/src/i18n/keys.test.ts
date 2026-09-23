import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@comitiva/contract';
import en from './en.json';
import ptBR from './pt-BR.json';

const entries = (obj: object, prefix = ''): Array<[string, string]> =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? entries(v as object, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)] as [string, string]],
  );

const variables = (text: string) => [...text.matchAll(/{{\s*(\w+)/g)].map((m) => m[1]).sort();

const keys = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('i18n', () => {
  it('has the same keys in every language', () => {
    expect(keys(ptBR).sort()).toEqual(keys(en).sort());
  });

  it('uses the same {{variables}} in every language', () => {
    const pt = new Map(entries(ptBR));
    const mismatched = entries(en).filter(
      ([key, text]) =>
        JSON.stringify(variables(text)) !== JSON.stringify(variables(pt.get(key) ?? '')),
    );
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it('has no empty strings', () => {
    expect([...entries(en), ...entries(ptBR)].filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('translates every error code (the UI shows errors by code)', () => {
    expect(ErrorCode.options.filter((code) => !(code in en.errors))).toEqual([]);
  });
});
