import { loadEnvConfig } from '@next/env';

let loaded = false;

/**
 * Loads .env files exactly as Next.js does (in test mode: .env.test, then .env; never
 * .env.local), so tests and tooling see the same variables as the app.
 */
export function loadProjectEnv(): void {
  if (loaded) {
    return;
  }
  loadEnvConfig(process.cwd(), undefined, {
    info: () => undefined,
    error: (...args: unknown[]) => {
      console.error(...args);
    },
  });
  loaded = true;
}
