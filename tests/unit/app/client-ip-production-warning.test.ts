import { describe, expect, it, vi } from 'vitest';

/**
 * B1 follow-up: in production a missing or malformed client-IP header is reported once (the
 * header value itself is never logged), because every such request shares the `unknown` bucket.
 * Own file so the module's once-flag and the cached environment start fresh with NODE_ENV set
 * to production before the first import.
 */
vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');

const { clientIp } = await import('@/app/_lib/client-ip');

describe('clientIp in production', () => {
  it('warns exactly once about a missing or malformed header, without echoing its value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(clientIp(new Headers())).toBe('unknown');
      expect(clientIp(new Headers({ 'x-real-ip': 'secret-looking-value-123' }))).toBe('unknown');
      expect(clientIp(new Headers({ 'x-real-ip': 'garbage' }))).toBe('unknown');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('x-real-ip');
      expect(message).toContain("'unknown'");
      expect(message).not.toContain('secret-looking-value-123');
      expect(message).not.toContain('garbage');
      // A valid address afterwards is returned as such and adds no warning.
      expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
