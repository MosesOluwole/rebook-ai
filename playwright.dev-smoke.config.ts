import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Non-blocking smoke run against `next dev` (`pnpm test:e2e:dev-smoke`): proves the dev server
 * boots and serves pages. It is never a gate; the gate is playwright.config.ts against a
 * production build. Its own port, and never an already-running server.
 *
 * Only specs that hit no rate limit belong here: development trusts no client-IP header, so every
 * request shares one bucket (src/app/_lib/client-ip.ts).
 */
const PORT = 3200;
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['health.spec.ts', 'home.spec.ts'],
  // Outside the project: `next dev` watches the project root, and Playwright's artefact folders
  // appearing under ./test-results made it recompile and reload the page in a loop.
  outputDir: join(tmpdir(), 'rebook-ai-dev-smoke-results'),
  retries: 0,
  reporter: [['list']],
  use: { baseURL: ORIGIN },
  projects: [{ name: 'dev-smoke', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `${ORIGIN}/health`,
    reuseExistingServer: false,
    env: { APP_ORIGIN: ORIGIN },
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
