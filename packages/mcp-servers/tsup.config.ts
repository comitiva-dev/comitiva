import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
    format: ['esm'],
    clean: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
  },
  // Self-contained server binaries: shells run them with any Node 22+
  // (Electron with ELECTRON_RUN_AS_NODE=1 in the desktop).
  {
    entry: { filesystem: 'src/filesystem/bin.ts', 'google-drive': 'src/google-drive/bin.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node22',
    platform: 'node',
    noExternal: [/.*/],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
