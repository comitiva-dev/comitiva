import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateJsonSchemas } from '../src/schema.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.json')) rmSync(join(outDir, file));
}
const schemas = generateJsonSchemas();
for (const [file, schema] of Object.entries(schemas)) {
  writeFileSync(join(outDir, file), `${JSON.stringify(schema, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${outDir}`);
