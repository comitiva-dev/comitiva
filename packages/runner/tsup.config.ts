import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
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
    // The MCP proxy CLI harnesses launch (ADR 0009) ships next to the binary.
    entry: { bin: 'src/bin.ts', 'mcp-proxy': 'src/proxy/bin.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node22',
    platform: 'node',
    noExternal: [/.*/],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  // Fake CLI harness for tests: one script, installed under the names the
  // adapters look for (it picks its behavior from its file name).
  {
    // ESM: the extensionless copies load as modules ("type": "module").
    entry: { 'testing/fake-harness': 'src/testing/fakeHarness.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    onSuccess: async () => {
      mkdirSync('dist/testing/bin', { recursive: true });
      for (const name of ['fake-claude', 'fake-codex']) {
        const target = `dist/testing/bin/${name}`;
        copyFileSync('dist/testing/fake-harness.js', target);
        chmodSync(target, 0o755);
      }
    },
  },
]);
