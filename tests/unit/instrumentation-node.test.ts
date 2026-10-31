import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type * as InstrumentationNode from '@/instrumentation.node';

/**
 * Proves the boot-time guard at the function level (docs/phases.md, Phase 0 acceptance
 * criterion 4): with an invalid environment, `validateEnvironmentOrExit` prints every problem and
 * ends the process with exit code 1; with a valid one it returns and exits nothing.
 * tests/integration/boot-env.test.ts proves the same through a real `next dev` process.
 */

const VALID_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** The Supabase variables are valid in every case here; the cases are about the others. */
function stubSupabaseEnv(): void {
  vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
}
const EXIT_SENTINEL = 'process.exit was called';

async function loadFresh(): Promise<typeof InstrumentationNode> {
  // getEnv() caches per module instance, so every test needs a fresh copy of the module graph.
  vi.resetModules();
  return import('@/instrumentation.node');
}

describe('validateEnvironmentOrExit', () => {
  let exit: MockInstance<typeof process.exit>;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error(EXIT_SENTINEL);
    });
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock('@/shared/config/env');
  });

  it('prints every problem and exits with code 1 when the environment is invalid', async () => {
    stubSupabaseEnv();
    vi.stubEnv('APP_DATABASE_URL', '');
    vi.stubEnv('APP_ORIGIN', 'ftp://not-a-web-origin');
    const { validateEnvironmentOrExit } = await loadFresh();

    expect(() => {
      validateEnvironmentOrExit();
    }).toThrow(EXIT_SENTINEL);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    const printed = consoleError.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(printed).toMatch(/Invalid environment configuration \(2 problems\)/);
    expect(printed).toMatch(/APP_DATABASE_URL: missing\. Expected Postgres connection string/);
    expect(printed).toMatch(/APP_ORIGIN: .*Expected public origin of the web app/);
    expect(printed).toMatch(/Copy \.env\.example to \.env .*docs\/setup\.md/);
  });

  it('returns without printing or exiting when the environment is valid', async () => {
    stubSupabaseEnv();
    vi.stubEnv('APP_DATABASE_URL', VALID_DATABASE_URL);
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('NODE_ENV', 'test');
    const { validateEnvironmentOrExit } = await loadFresh();

    expect(() => {
      validateEnvironmentOrExit();
    }).not.toThrow();

    expect(exit).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not swallow errors that are not environment validation failures', async () => {
    vi.doMock('@/shared/config/env', () => ({
      EnvValidationError: class EnvValidationError extends Error {},
      getEnv: () => {
        throw new TypeError('unrelated failure while reading configuration');
      },
    }));
    const { validateEnvironmentOrExit } = await loadFresh();

    expect(() => {
      validateEnvironmentOrExit();
    }).toThrow(TypeError);

    expect(exit).not.toHaveBeenCalled();
  });
});
