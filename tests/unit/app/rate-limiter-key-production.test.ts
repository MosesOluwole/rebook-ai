import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { type RateLimiter, type RateLimitSubject } from '@/modules/platform';

/**
 * Phase 2 follow-ups (ADR-004 §9): in production the limiter's IP key comes from Vercel's
 * platform-set header only. A client-supplied X-Forwarded-For, or the e2e test header, never
 * changes it. Exercised through `rateLimitOrNull`, the entry point every form route calls, with a
 * recording limiter in its process-wide slot so the subject it would hash is observable without a
 * database. Own file: NODE_ENV must be production before the environment is first read.
 */
vi.stubEnv('NODE_ENV', 'production');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', 'https://app.example');

const subjects: RateLimitSubject[] = [];
const recording: RateLimiter = {
  enforce: (_scope, subject) => {
    subjects.push(subject);
    return Promise.resolve();
  },
};
(globalThis as unknown as Record<symbol, RateLimiter>)[Symbol.for('rebook-ai.rate-limiter')] =
  recording;

const { rateLimitOrNull } = await import('@/app/_lib/rate-limiter');

async function ipKeyFor(headers: Record<string, string>): Promise<string | undefined> {
  const request = new NextRequest('https://app.example/auth/password', {
    method: 'POST',
    headers,
  });
  expect(await rateLimitOrNull(request, 'sign_in', 'someone@example.test', '/sign-in')).toBeNull();
  return subjects.at(-1)?.ip;
}

describe('rate-limit key in production', () => {
  it('is the platform header, unchanged by any spoofed X-Forwarded-For', async () => {
    const platform = { 'x-vercel-forwarded-for': '203.0.113.9' };
    expect(await ipKeyFor(platform)).toBe('203.0.113.9');
    for (const spoofed of ['198.51.100.1', '198.51.100.2, 203.0.113.9', '10.0.0.1']) {
      expect(await ipKeyFor({ ...platform, 'x-forwarded-for': spoofed }), spoofed).toBe(
        '203.0.113.9',
      );
    }
  });

  it('ignores the e2e test header and X-Real-IP', async () => {
    expect(
      await ipKeyFor({
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-rebook-test-client-ip': '198.51.100.7',
        'x-real-ip': '198.51.100.8',
      }),
    ).toBe('203.0.113.9');
  });

  it('cannot be escaped by a client that sends only X-Forwarded-For: it shares the unknown bucket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await ipKeyFor({ 'x-forwarded-for': '198.51.100.1' })).toBe('unknown');
      expect(await ipKeyFor({ 'x-forwarded-for': '198.51.100.2' })).toBe('unknown');
    } finally {
      warn.mockRestore();
    }
  });
});
