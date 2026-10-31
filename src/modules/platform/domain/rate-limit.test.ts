import { describe, expect, it } from 'vitest';

import {
  AUTH_RATE_LIMIT_SCOPES,
  AUTH_RATE_LIMITS,
  normaliseEmail,
  RateLimitedError,
  rateLimitSubject,
  secondsUntilWindowEnd,
  windowStart,
} from './rate-limit';

describe('rate limit rules', () => {
  it('limits every authentication scope by IP and by email, email tighter than IP', () => {
    for (const scope of AUTH_RATE_LIMIT_SCOPES) {
      const rules = AUTH_RATE_LIMITS[scope];
      expect(rules.ip.limit).toBeGreaterThan(rules.email.limit);
      expect(rules.ip.windowSeconds).toBeGreaterThan(0);
      expect(rules.email.windowSeconds).toBeGreaterThan(0);
    }
  });

  it('normalises addresses and builds distinct subjects per scope and kind', () => {
    expect(normaliseEmail('  Pat@Example.COM ')).toBe('pat@example.com');
    expect(rateLimitSubject('sign_in', 'email', 'pat@example.com')).toBe(
      'sign_in:email:pat@example.com',
    );
    expect(rateLimitSubject('sign_in', 'ip', '10.0.0.1')).not.toBe(
      rateLimitSubject('sign_up', 'ip', '10.0.0.1'),
    );
  });

  it('computes fixed windows the way the database does', () => {
    const at = new Date('2026-11-01T10:07:30Z');
    expect(windowStart(at, 600).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(windowStart(new Date('2026-11-01T10:10:00Z'), 600).toISOString()).toBe(
      '2026-11-01T10:10:00.000Z',
    );
    expect(secondsUntilWindowEnd(at, 600)).toBe(150);
    expect(secondsUntilWindowEnd(new Date('2026-11-01T10:09:59.500Z'), 600)).toBe(1);
  });

  it('describes a refusal without naming the key', () => {
    const error = new RateLimitedError('sign_in', 120);
    expect(error.message).toBe('Too many attempts. Try again in a few minutes.');
    expect(error).toMatchObject({
      kind: 'RateLimitedError',
      scope: 'sign_in',
      retryAfterSeconds: 120,
    });
  });
});
