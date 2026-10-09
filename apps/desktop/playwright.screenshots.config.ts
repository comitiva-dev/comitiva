import { defineConfig } from '@playwright/test';

/**
 * Not a test suite: stages a team of agents against the fake providers and
 * saves screenshots to docs/images (e2e-screenshots/screenshots.spec.ts).
 */
export default defineConfig({
  testDir: './e2e-screenshots',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  outputDir: './test-results/screenshots',
});
