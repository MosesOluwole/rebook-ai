/**
 * Platform module: cross-cutting operational concerns (health, rate limiting; metrics and
 * runbook hooks later). This file is the module's only public surface and its composition root.
 */
import { type TenantRunner } from '@/modules/tenancy';
import { getEnv } from '@/shared/config/env';
import { type Clock } from '@/shared/kernel/clock';

import { getHealthReport as reportHealth } from './application/health-service';
import { enforceAuthRateLimit, type RateLimitSubject } from './application/rate-limiter';
import { type HealthReport } from './domain/health';
import { type AuthRateLimitScope } from './domain/rate-limit';
import { buildInfo } from './infrastructure/build-info';
import { hashRateLimitKey } from './infrastructure/key-hash';
import { createRateLimitStore } from './infrastructure/rate-limits-repository';
import { systemClock } from './infrastructure/system-clock';

export type { HealthReport } from './domain/health';
export {
  AUTH_RATE_LIMIT_SCOPES,
  AUTH_RATE_LIMITS,
  normaliseEmail,
  RateLimitedError,
  type AuthRateLimitScope,
  type RateLimitRule,
} from './domain/rate-limit';
export { type RateLimitSubject } from './application/rate-limiter';

export interface RateLimiter {
  /** Counts one attempt and throws RateLimitedError when the IP or email limit is exceeded. */
  enforce(scope: AuthRateLimitScope, subject: RateLimitSubject, requestId: string): Promise<void>;
}

/** Composition root for the fixed-window limiter over the tenancy module's anonymous runner. */
export function createRateLimiter(
  runner: Pick<TenantRunner, 'withAnonymousContext'>,
  clock: Clock = systemClock,
): RateLimiter {
  return {
    enforce: (scope, subject, requestId) =>
      enforceAuthRateLimit(
        { store: createRateLimitStore(runner, requestId), clock, hash: hashRateLimitKey },
        scope,
        subject,
      ),
  };
}

export function getHealthReport(): HealthReport {
  return reportHealth({
    clock: systemClock,
    version: buildInfo.version,
    environment: getEnv().NODE_ENV,
  });
}
