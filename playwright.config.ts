import { defineConfig, devices } from '@playwright/test';

/**
 * The e2e gate: a fresh production build on a dedicated port, started by Playwright itself and
 * never reused, so a stale or half-broken `next dev` can neither pass nor fail the gate
 * (docs/setup.md). The dev server is covered only by the non-blocking smoke run in
 * playwright.dev-smoke.config.ts.
 *
 * The server runs with NODE_ENV=test (the bundle is still the production build; `next start`
 * keeps the runtime value): that is the only mode in which the app trusts the test client-IP
 * header Playwright sends (src/app/_lib/client-ip.ts). APP_ORIGIN is this server's own origin, so
 * invite links and the same-origin check point here and nowhere else.
 */
const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;
const isCI = process.env.CI === 'true' || process.env.CI === '1';

// tests/e2e/helpers/fixtures.ts gives every test, and every secondary context, its own fake client
// IP; this run-level header covers the `request` fixture and anything created outside them.
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
    baseURL: ORIGIN,
    extraHTTPHeaders: { 'x-rebook-test-client-ip': RUN_CLIENT_IP },
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
    command: `NODE_ENV=production pnpm build && NODE_ENV=test pnpm start --port ${PORT}`,
    url: `${ORIGIN}/health`,
    // Never attach to whatever already listens on the port: the gate always tests this build.
    reuseExistingServer: false,
    env: { APP_ORIGIN: ORIGIN },
    // Covers the build as well as the start.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
