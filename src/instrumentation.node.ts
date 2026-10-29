import { EnvValidationError, getEnv } from './shared/config/env';

/**
 * Validates the environment at boot. This is what makes a missing variable fail the start-up
 * instead of the first request that happens to need it. Next.js itself only logs an error thrown
 * from `register` and, in production, keeps serving, so a validation failure ends the process.
 */
export function validateEnvironmentOrExit(): void {
  try {
    getEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
