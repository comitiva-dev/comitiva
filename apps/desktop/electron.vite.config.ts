import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// Only `dependencies` (native better-sqlite3) stay external; workspace
// packages and everything else is bundled into main/preload.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
  },
});
