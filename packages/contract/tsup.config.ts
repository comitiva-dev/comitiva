import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/ipc-channels.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node22',
});
