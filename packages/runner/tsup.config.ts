import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entries for shells and tests (dependencies stay external).
  {
    entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    sourcemap: true,
  },
  // Self-contained runner binary: every dependency bundled so shells can run
  // it with any Node 22+ (including Electron with ELECTRON_RUN_AS_NODE=1).
  {
    entry: { bin: 'src/bin.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node22',
    platform: 'node',
    noExternal: [/.*/],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
