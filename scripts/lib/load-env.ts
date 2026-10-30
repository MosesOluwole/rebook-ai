import { createRequire } from 'node:module';

import type * as NextEnv from '@next/env';

/**
 * Loads .env the way Next.js does. `@next/env` is a CommonJS bundle whose named exports Node's
 * ESM loader cannot detect, so scripts (run by tsx under native ESM) go through require().
 */
export function loadProjectEnv(): void {
  const nextEnv = createRequire(import.meta.url)('@next/env') as typeof NextEnv;
  nextEnv.loadEnvConfig(process.cwd(), undefined, {
    info: () => undefined,
    error: () => undefined,
  });
}
