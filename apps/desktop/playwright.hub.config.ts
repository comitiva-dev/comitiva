import { defineConfig } from '@playwright/test';

/**
 * Two desktops against a real hub (the Phase 8 exit criterion). Needs Docker
 * and the hub's image: HUB_IMAGE, or comitiva-hub:local built from the hub
 * repository (docs/hub.md → Testing).
 */
export default defineConfig({
  testDir: './e2e-hub',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  globalSetup: './e2e-hub/global-setup.ts',
});
