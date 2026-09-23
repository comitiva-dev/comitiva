import { defineConfig } from '@playwright/test';

/**
 * Smoke test of the packaged app (release/*-unpacked or the .app), run after
 * `pnpm package` locally and on each OS in CI. The regular e2e suite runs the
 * built but unpacked app (playwright.config.ts).
 */
export default defineConfig({
  testDir: './e2e-packaged',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  outputDir: './test-results/packaged',
});
