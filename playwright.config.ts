import { defineConfig } from '@playwright/test';

// SECURITY: headless only, loopback only. The preview server is spun up for the
// test run and torn down after. It never binds to a non-loopback interface.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Seed the "welcome tour seen" flag so the first-run tour modal does not block interaction in
    // specs that are not about the tour. The tour's own spec clears it via addInitScript.
    storageState: 'tests/e2e/.storage.json',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
