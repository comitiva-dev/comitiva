import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateJsonSchemas } from '../src/index.js';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

describe('JSON Schema output', () => {
  const generated = generateJsonSchemas();

  it('matches the committed files (run `pnpm contract:schema` if this fails)', () => {
    const committed = readdirSync(schemaDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(committed).toEqual(Object.keys(generated).sort());
    for (const [file, schema] of Object.entries(generated)) {
      expect(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')), file).toEqual(schema);
    }
  });

  it('emits draft 2020-12 documents with stable ids', () => {
    const runnerRequest = generated['RunnerRequest.json'] as Record<string, unknown>;
    expect(runnerRequest.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(runnerRequest.$id).toBe('https://comitiva.dev/schema/RunnerRequest.json');
  });
});
