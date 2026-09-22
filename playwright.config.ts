import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against whatever is already listening on :3000 - either `pnpm dev` on
 * the host or the full docker-compose stack. It never starts its own server:
 * this suite exercises real cross-service behaviour (auth cookies, the
 * gateway proxy, MailHog), which a mocked single-process server would not.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false, // shared demo accounts; parallel runs would race each other
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
