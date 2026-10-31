import { sql } from 'drizzle-orm';

import { type AnonymousTx, type TenantRunner } from '@/modules/tenancy';

import { type RateLimitHit, type RateLimitStore } from '../application/rate-limiter';

/**
 * `rebook.rate_limits` through `rebook.rate_limit_hit()`, inside one anonymous transaction per
 * call (docs/adr/ADR-004 §9). The clock is passed in so tests can move windows.
 */
export async function hitRateLimits(
  tx: AnonymousTx,
  hits: readonly RateLimitHit[],
  at: Date,
): Promise<boolean[]> {
  const results: boolean[] = [];
  for (const hit of hits) {
    const rows = await tx.db.execute<{ allowed: boolean }>(
      sql`select rebook.rate_limit_hit(${hit.key}, ${hit.rule.windowSeconds}, ${hit.rule.limit}, ${at.toISOString()}::timestamptz) as allowed`,
    );
    results.push(rows[0]?.allowed === true);
  }
  return results;
}

export function createRateLimitStore(
  runner: Pick<TenantRunner, 'withAnonymousContext'>,
  requestId: string,
): RateLimitStore {
  return {
    hitAll: (hits, at) =>
      runner.withAnonymousContext(requestId, (tx) => hitRateLimits(tx, hits, at)),
  };
}
