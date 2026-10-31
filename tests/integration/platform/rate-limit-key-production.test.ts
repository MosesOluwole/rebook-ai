import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH_RATE_LIMITS, createRateLimiter, type RateLimiter } from '@/modules/platform';

import type { rateLimitOrNull as RateLimitOrNull } from '@/app/_lib/rate-limiter';

import { connectAppDb, type AppDb } from '../../helpers/db';

/**
 * Phase 2 follow-ups, criterion 5 (ADR-004 §9), proven on the stored key rather than on the
 * subject: in production mode `rateLimitOrNull` (the entry point of every form route) bumps the
 * counter whose key is the hash of the Vercel platform header's address, and a spoofed
 * X-Forwarded-For (or the e2e test header) neither creates a counter of its own nor escapes the
 * shared one. Real limiter, real hashing, real Postgres as rebook_app via withAnonymousContext;
 * only the clock is fixed so the whole run sits inside one window.
 *
 * Own file: NODE_ENV must be production before the environment is first read.
 */
vi.stubEnv('NODE_ENV', 'production');

let app: AppDb;
const at = new Date('2026-11-04T09:00:30Z');

const slot = Symbol.for('rebook-ai.rate-limiter');
const holder = globalThis as unknown as Record<symbol, RateLimiter | undefined>;

/** A fresh IPv6 documentation address per run, so earlier runs' counters never collide. */
const docIp = (): string =>
  `2001:db8::${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;

/**
 * The derivation in src/modules/platform/infrastructure/key-hash.ts, pinned here on purpose: the
 * platform module does not expose it, and a changed derivation should fail this test loudly
 * (undefined counts) rather than silently follow the code under test.
 */
const keyFor = (value: string): string =>
  createHash('sha256').update(`rebook-rate-limit:sign_in:ip:${value}`, 'utf8').digest('hex');

async function counts(keys: readonly string[]): Promise<Map<string, number>> {
  const rows = await app.tenancy.withAnonymousContext('rl-prod-key-read', (tx) =>
    tx.db.execute<{ key: string; count: number }>(sql`
      select key, sum(count)::int as count from rebook.rate_limits
      where key in (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})
      group by key
    `),
  );
  return new Map(rows.map((row) => [row.key, row.count]));
}

let rateLimitOrNull: typeof RateLimitOrNull;

beforeAll(async () => {
  app = await connectAppDb();
  holder[slot] = createRateLimiter(app.tenancy.runner, { now: () => at });
  ({ rateLimitOrNull } = await import('@/app/_lib/rate-limiter'));
});

afterAll(async () => {
  holder[slot] = undefined;
  await app.close();
});

function post(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://app.example/auth/password', { method: 'POST', headers });
}

const address = (n: number) =>
  `prod-key-${String(n)}-${randomBytes(3).toString('hex')}@example.invalid`;

describe('rate-limit key in production (stored counters)', () => {
  it('keys on x-vercel-forwarded-for only; spoofed X-Forwarded-For and the test header create no counter and do not reset the limit', async () => {
    const platform = docIp();
    const spoofs = Array.from({ length: AUTH_RATE_LIMITS.sign_in.ip.limit }, () => docIp());
    const testHeader = docIp();

    for (const [index, spoof] of spoofs.entries()) {
      const response = await rateLimitOrNull(
        post({
          'x-vercel-forwarded-for': platform,
          'x-forwarded-for': spoof,
          'x-rebook-test-client-ip': testHeader,
          'x-real-ip': spoof,
        }),
        'sign_in',
        address(index),
        '/sign-in',
      );
      expect(response, `attempt ${String(index + 1)}`).toBeNull();
    }

    // One more from the same platform address, with yet another spoofed X-Forwarded-For and a new
    // address: the IP budget is spent, so it is refused.
    const over = await rateLimitOrNull(
      post({ 'x-vercel-forwarded-for': platform, 'x-forwarded-for': docIp() }),
      'sign_in',
      address(999),
      '/sign-in',
    );
    expect(over?.status).toBe(429);

    const stored = await counts([keyFor(platform), keyFor(testHeader), ...spoofs.map(keyFor)]);
    expect(stored.get(keyFor(platform))).toBe(AUTH_RATE_LIMITS.sign_in.ip.limit + 1);
    expect(stored.get(keyFor(testHeader))).toBeUndefined();
    for (const spoof of spoofs) {
      expect(stored.get(keyFor(spoof)), 'a spoofed address got its own counter').toBeUndefined();
    }

    // A different platform address is a different client and is unaffected.
    const other = await rateLimitOrNull(
      post({ 'x-vercel-forwarded-for': docIp(), 'x-forwarded-for': platform }),
      'sign_in',
      address(1000),
      '/sign-in',
    );
    expect(other).toBeNull();
  });

  it('a client sending only X-Forwarded-For lands on the shared unknown counter, not its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const spoof = docIp();
      const before = (await counts([keyFor('unknown')])).get(keyFor('unknown')) ?? 0;
      await rateLimitOrNull(post({ 'x-forwarded-for': spoof }), 'sign_in', address(1), '/sign-in');
      const after = await counts([keyFor('unknown'), keyFor(spoof)]);
      expect(after.get(keyFor('unknown'))).toBe(before + 1);
      expect(after.get(keyFor(spoof))).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
