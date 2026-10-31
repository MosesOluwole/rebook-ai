import { type Clock } from '@/shared/kernel/clock';

import {
  AUTH_RATE_LIMITS,
  type AuthRateLimitScope,
  normaliseEmail,
  type RateLimitRule,
  RateLimitedError,
  rateLimitSubject,
  secondsUntilWindowEnd,
} from '../domain/rate-limit';

/** One counter to bump: the hashed key and the rule that governs it. */
export interface RateLimitHit {
  readonly key: string;
  readonly rule: RateLimitRule;
}

/** Port: counts the hits for several keys in the window containing `at`; true means still allowed. */
export interface RateLimitStore {
  hitAll(hits: readonly RateLimitHit[], at: Date): Promise<readonly boolean[]>;
}

export interface RateLimiterDeps {
  readonly store: RateLimitStore;
  readonly clock: Clock;
  /** Turns a subject (`scope:kind:value`) into the stored key; the store never sees the value. */
  readonly hash: (subject: string) => string;
}

export interface RateLimitSubject {
  readonly ip: string;
  /** Omitted when the flow has no address yet (none of the Phase 2 flows omit it). */
  readonly email?: string;
}

/**
 * Counts one attempt against the scope's IP and email limits and refuses with RateLimitedError
 * when either is exceeded. Both counters are bumped even when one refuses, so an attacker
 * rotating addresses still burns the IP budget and vice versa.
 */
export async function enforceAuthRateLimit(
  deps: RateLimiterDeps,
  scope: AuthRateLimitScope,
  subject: RateLimitSubject,
): Promise<void> {
  const rules = AUTH_RATE_LIMITS[scope];
  const at = deps.clock.now();
  const hits: RateLimitHit[] = [
    { key: deps.hash(rateLimitSubject(scope, 'ip', subject.ip)), rule: rules.ip },
  ];
  if (subject.email !== undefined && subject.email.trim() !== '') {
    hits.push({
      key: deps.hash(rateLimitSubject(scope, 'email', normaliseEmail(subject.email))),
      rule: rules.email,
    });
  }
  const allowed = await deps.store.hitAll(hits, at);
  const refused = hits.filter((_, index) => allowed[index] !== true);
  if (refused.length > 0) {
    const retryAfter = Math.max(
      ...refused.map((hit) => secondsUntilWindowEnd(at, hit.rule.windowSeconds)),
    );
    throw new RateLimitedError(scope, retryAfter);
  }
}
