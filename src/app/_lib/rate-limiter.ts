import { randomUUID } from 'node:crypto';

import { type NextRequest, type NextResponse } from 'next/server';

import {
  type AuthRateLimitScope,
  createRateLimiter,
  type RateLimiter,
  RateLimitedError,
} from '@/modules/platform';

import { clientIp } from './client-ip';
import { isTypedError } from './form-errors';
import { tooManyRequests, wantsJson } from './http';
import { getTenancy } from './tenancy';

const key = Symbol.for('rebook-ai.rate-limiter');
const holder = globalThis as unknown as { [key]?: RateLimiter };

function getRateLimiter(): RateLimiter {
  holder[key] ??= createRateLimiter(getTenancy().runner);
  return holder[key];
}

/**
 * Counts this attempt against the scope's IP and email limits. Returns the 429 response to send
 * when a limit is exceeded, or null to continue. Called before any credential is checked, so a
 * refused attempt learns nothing (docs/adr/ADR-004 §9).
 */
export async function rateLimitOrNull(
  request: NextRequest,
  scope: AuthRateLimitScope,
  email: string | undefined,
  backTo: string,
): Promise<NextResponse | null> {
  try {
    await getRateLimiter().enforce(scope, { ip: clientIp(request.headers), email }, randomUUID());
    return null;
  } catch (error) {
    if (isTypedError(error, RateLimitedError)) {
      return tooManyRequests(error.retryAfterSeconds, backTo, wantsJson(request));
    }
    throw error;
  }
}
