import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 2 follow-up 5: the client IP comes from the one header CLIENT_IP_HEADER names; only
 * the first address counts; anything else lands in the shared `unknown` bucket. Pure: the
 * environment is stubbed with synthetic values, no database or network.
 */
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
// Mixed case on purpose: the schema lower-cases it and Headers lookups are case-insensitive.
vi.stubEnv('CLIENT_IP_HEADER', 'X-Forwarded-For');

const { clientIp } = await import('@/app/_lib/client-ip');

describe('clientIp', () => {
  it('takes the first address of the configured header', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.9',
    );
    expect(clientIp(new Headers({ 'X-Forwarded-For': '  198.51.100.4  ' }))).toBe('198.51.100.4');
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('falls into the shared unknown bucket when the header is missing or not an IP', () => {
    expect(clientIp(new Headers())).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': '' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'not-an-ip' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9:1234' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'example.invalid, 203.0.113.9' }))).toBe(
      'unknown',
    );
  });

  it('ignores every header but the configured one', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('unknown');
    expect(clientIp(new Headers({ forwarded: 'for=203.0.113.9' }))).toBe('unknown');
    expect(
      clientIp(new Headers({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.4' })),
    ).toBe('198.51.100.4');
  });
});
