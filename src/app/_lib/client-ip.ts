import { isIP } from 'node:net';

import { getEnv } from '@/shared/config/env';

/**
 * The client IP for rate limiting, read from the one header the trusted reverse proxy sets
 * (`CLIENT_IP_HEADER`, docs/adr/ADR-004 §9). Only the first address of a comma-separated list
 * counts; anything that is not an IP falls into a shared bucket rather than escaping limits.
 */
let warnedOnce = false;

export function clientIp(headers: Headers): string {
  const env = getEnv();
  const raw = headers.get(env.CLIENT_IP_HEADER);
  const first = raw?.split(',')[0]?.trim() ?? '';
  if (isIP(first) === 0) {
    // Every such request shares one bucket, so a misconfigured header shows up as site-wide
    // limits. Say so once; the header value itself is never logged.
    if (env.NODE_ENV === 'production' && !warnedOnce) {
      warnedOnce = true;
      console.warn(
        `clientIp: header ${env.CLIENT_IP_HEADER} is missing or not an IP address; rate limits are using the shared 'unknown' bucket. Check the proxy configuration.`,
      );
    }
    return 'unknown';
  }
  return first;
}
