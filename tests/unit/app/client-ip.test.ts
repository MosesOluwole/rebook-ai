import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 2 follow-ups: under NODE_ENV=test the client IP comes from the test header only; only
 * the first address counts; anything else lands in the shared `unknown` bucket. Pure: the
 * environment is stubbed with synthetic values, no database or network. Production is covered
 * by client-ip-production-warning.test.ts and rate-limiter-key-production.test.ts.
 */
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', 'http://localhost:3100');

const { clientIp, TRUSTED_CLIENT_IP_HEADER } = await import('@/app/_lib/client-ip');

const TEST_HEADER = 'x-rebook-test-client-ip';

describe('TRUSTED_CLIENT_IP_HEADER', () => {
  it('trusts the platform header in production, the test header only in test, nothing in development', () => {
    expect(TRUSTED_CLIENT_IP_HEADER).toEqual({
      production: 'x-vercel-forwarded-for',
      test: TEST_HEADER,
      development: null,
    });
  });
});

describe('clientIp under NODE_ENV=test', () => {
  it('takes the first address of the test header', () => {
    expect(clientIp(new Headers({ [TEST_HEADER]: '203.0.113.9, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.9',
    );
    expect(clientIp(new Headers({ 'X-Rebook-Test-Client-IP': '  198.51.100.4  ' }))).toBe(
      '198.51.100.4',
    );
    expect(clientIp(new Headers({ [TEST_HEADER]: '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('falls into the shared unknown bucket when the header is missing or not an IP', () => {
    expect(clientIp(new Headers())).toBe('unknown');
    expect(clientIp(new Headers({ [TEST_HEADER]: '' }))).toBe('unknown');
    expect(clientIp(new Headers({ [TEST_HEADER]: 'not-an-ip' }))).toBe('unknown');
    expect(clientIp(new Headers({ [TEST_HEADER]: '203.0.113.9:1234' }))).toBe('unknown');
    expect(clientIp(new Headers({ [TEST_HEADER]: 'example.invalid, 203.0.113.9' }))).toBe(
      'unknown',
    );
  });

  it('ignores every other header, x-forwarded-for and the platform header included', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '203.0.113.9' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('unknown');
    expect(
      clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9', [TEST_HEADER]: '198.51.100.4' })),
    ).toBe('198.51.100.4');
  });
});
