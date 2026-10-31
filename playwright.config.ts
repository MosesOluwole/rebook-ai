import { defineConfig, devices } from '@playwright/test';

// PORT lets a production-mode run (`CI=true PORT=3100 pnpm test:e2e`) coexist with a dev server.
const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const isCI = process.env.CI === 'true' || process.env.CI === '1';

// Rate limits key on the client IP read from CLIENT_IP_HEADER (x-forwarded-for locally and in
// CI). tests/e2e/helpers/fixtures.ts gives every test, and every secondary context, its own
// fake client IP; this run-level header is the fallback for anything created outside them.
const octet = () => Math.floor(Math.random() * 254) + 1;
const RUN_CLIENT_IP = `10.${octet()}.${octet()}.${octet()}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  // A flaky test is a failing test: no retries anywhere.
  retries: 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': RUN_CLIENT_IP },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Every phase's screens must work at 375 px wide (docs/phases.md, definition of done).
      name: 'mobile-375',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 667 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    // CI runs the production build (`pnpm build` runs first in the workflow); locally the dev server.
    command: isCI ? `pnpm start --port ${PORT}` : `pnpm dev --port ${PORT}`,
    url: `${baseURL}/health`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
