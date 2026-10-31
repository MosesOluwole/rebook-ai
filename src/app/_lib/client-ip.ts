import { isIP } from 'node:net';

import { type Environment, getEnv } from '@/shared/config/env';

/**
 * The one header trusted to carry the client IP in each environment (docs/adr/ADR-004 §9).
 * Fixed in code, not configurable, so no deployment can be talked into trusting a header the
 * client controls:
 *
 * - production: `x-vercel-forwarded-for`, which Vercel's edge sets itself. A client-supplied
 *   `x-forwarded-for` (or any other header) is never read.
 * - test: `x-rebook-test-client-ip`, sent by Playwright so each test is its own client. Only the
 *   e2e gate's server runs with NODE_ENV=test; a production deployment never does.
 * - development: none. Every request shares one bucket; the per-address limits still apply.
 */
export const TRUSTED_CLIENT_IP_HEADER: Readonly<Record<Environment, string | null>> = {
  production: 'x-vercel-forwarded-for',
  test: 'x-rebook-test-client-ip',
  development: null,
};

let warnedOnce = false;

/**
 * The client IP for rate limiting. Only the first address of a comma-separated list counts;
 * anything that is not an IP falls into a shared bucket rather than escaping limits.
 */
export function clientIp(headers: Headers): string {
  const env = getEnv();
  const header = TRUSTED_CLIENT_IP_HEADER[env.NODE_ENV];
  const raw = header === null ? null : headers.get(header);
  const first = raw?.split(',')[0]?.trim() ?? '';
  if (isIP(first) === 0) {
    // Every such request shares one bucket, so a missing platform header shows up as site-wide
    // limits. Say so once; the header value itself is never logged.
    if (env.NODE_ENV === 'production' && !warnedOnce) {
      warnedOnce = true;
      console.warn(
        `clientIp: header ${String(header)} is missing or not an IP address; rate limits are using the shared 'unknown' bucket. Check the hosting platform.`,
      );
    }
    return 'unknown';
  }
  return first;
}
