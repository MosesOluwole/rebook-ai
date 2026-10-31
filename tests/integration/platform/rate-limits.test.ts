import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTH_RATE_LIMIT_SCOPES,
  AUTH_RATE_LIMITS,
  createRateLimiter,
  RateLimitedError,
} from '@/modules/platform';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';

/**
 * The Postgres fixed-window rate limiter (docs/architecture.md §10, ADR-004 §9), driven through
 * the platform module over the tenancy module's anonymous runner. Both keys (client IP and
 * normalised email) are limited independently; the window resets on the clock; the table holds
 * hashes only.
 */

let owner: DbClient;
let app: AppDb;
let now: Date;
const clock = { now: () => now };

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  now = new Date('2026-11-02T09:00:30Z');
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

const ip = () =>
  `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
const email = () => `limit-${randomUUID().slice(0, 8)}@example.invalid`;

describe('enforceAuthRateLimit', () => {
  it('refuses the attempt after the email limit, independently of the IP', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = email();
    const { limit } = AUTH_RATE_LIMITS.sign_in.email;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await limiter.enforce('sign_in', { ip: ip(), email: address }, `rl-${attempt}`);
    }
    let caught: unknown;
    try {
      await limiter.enforce('sign_in', { ip: ip(), email: address.toUpperCase() }, 'rl-over');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(caught).toMatchObject({
      scope: 'sign_in',
      message: 'Too many attempts. Try again in a few minutes.',
    });
    expect((caught as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect((caught as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(
      AUTH_RATE_LIMITS.sign_in.email.windowSeconds,
    );
    // A different address from the same IPs is still fine: the IP budget is larger.
    await limiter.enforce('sign_in', { ip: ip(), email: email() }, 'rl-other');
  });

  it('refuses the attempt after the IP limit, independently of the email', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = ip();
    const { limit } = AUTH_RATE_LIMITS.magic_link.ip;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await limiter.enforce('magic_link', { ip: address, email: email() }, `ip-${attempt}`);
    }
    await expect(
      limiter.enforce('magic_link', { ip: address, email: email() }, 'ip-over'),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // Another scope has its own counters for the same IP.
    await limiter.enforce('sign_in', { ip: address, email: email() }, 'ip-scope');
  });

  it('resets when the fixed window ends and keeps counting inside it', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = email();
    const rule = AUTH_RATE_LIMITS.magic_link.email;
    const windowStart = new Date('2026-11-02T10:00:00Z');
    now = new Date(windowStart.getTime() + 5_000);
    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await limiter.enforce('magic_link', { ip: ip(), email: address }, `w-${attempt}`);
    }
    // Still inside the window a minute later: refused.
    now = new Date(windowStart.getTime() + 60_000);
    await expect(
      limiter.enforce('magic_link', { ip: ip(), email: address }, 'w-inside'),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // First second of the next window: allowed again.
    now = new Date(windowStart.getTime() + rule.windowSeconds * 1000);
    await limiter.enforce('magic_link', { ip: ip(), email: address }, 'w-next');
    now = new Date('2026-11-02T09:00:30Z');
  });

  it('stores hashed keys and counters only, never an address', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = `plain-${randomUUID().slice(0, 8)}@example.invalid`;
    const client = '192.0.2.77';
    await limiter.enforce('sign_up', { ip: client, email: address }, 'hash-1');
    const rows = await owner.sql<{ key: string; count: number }[]>`
      select key, count from rebook.rate_limits
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).toMatch(/^[0-9a-f]{64}$/);
      expect(row.count).toBeGreaterThan(0);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(address);
    expect(dump).not.toContain(client);
  });
});

describe('withAnonymousContext', () => {
  it('runs as rebook_app with no tenant, no actor and the anonymous kind', async () => {
    const [state] = await app.tenancy.withAnonymousContext('anon-req-1', (tx) =>
      tx.db.execute<Record<'role' | 'tenant' | 'actor' | 'kind' | 'request', string>>(sql`
        select current_user::text as role,
               current_setting('app.tenant_id', true) as tenant,
               current_setting('app.actor_id', true) as actor,
               current_setting('app.actor_kind', true) as kind,
               current_setting('app.request_id', true) as request
      `),
    );
    expect(state).toEqual({
      role: 'rebook_app',
      tenant: '',
      actor: '',
      kind: 'anonymous',
      request: 'anon-req-1',
    });
  });

  it('sees zero rows in every tenant-owned table', async () => {
    const [row] = await app.tenancy.withAnonymousContext('anon-req-2', (tx) =>
      tx.db.execute<{ tenants: number; members: number; invitations: number }>(sql`
        select (select count(*) from rebook.tenants)::int as tenants,
               (select count(*) from rebook.tenant_memberships)::int as members,
               (select count(*) from rebook.tenant_invitations)::int as invitations
      `),
    );
    expect(row).toEqual({ tenants: 0, members: 0, invitations: 0 });
  });

  it('rejects a blank request id before opening a transaction', async () => {
    await expect(
      app.tenancy.withAnonymousContext('   ', () => Promise.resolve('ran')),
    ).rejects.toMatchObject({ name: 'TenantContextError' });
  });
});

// ---- Follow-up verification (test engineer) -------------------------------------------------

/** Seconds from `at` to the end of its fixed window, as the application computes Retry-After. */
function expectedRetryAfter(at: Date, windowSeconds: number): number {
  const ms = windowSeconds * 1000;
  const end = Math.floor(at.getTime() / ms) * ms + ms;
  return Math.max(1, Math.ceil((end - at.getTime()) / 1000));
}

async function refusal(promise: Promise<unknown>): Promise<RateLimitedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the attempt to be refused');
}

describe('every scope is limited on both keys with an exact Retry-After', () => {
  it.each(AUTH_RATE_LIMIT_SCOPES)(
    '%s: the address limit refuses the next attempt whatever the IP, with Retry-After to the window end',
    async (scope) => {
      const limiter = createRateLimiter(app.tenancy.runner, clock);
      const address = email();
      const rule = AUTH_RATE_LIMITS[scope].email;
      for (let attempt = 0; attempt < rule.limit; attempt += 1) {
        await limiter.enforce(scope, { ip: ip(), email: address }, `${scope}-e-${attempt}`);
      }
      const refused = await refusal(
        limiter.enforce(scope, { ip: ip(), email: address }, `${scope}-e-over`),
      );
      expect(refused.scope).toBe(scope);
      expect(refused.retryAfterSeconds).toBe(expectedRetryAfter(now, rule.windowSeconds));
      expect(refused.message).toBe('Too many attempts. Try again in a few minutes.');
    },
  );

  it.each(AUTH_RATE_LIMIT_SCOPES)(
    '%s: the IP limit refuses the next attempt whatever the address',
    async (scope) => {
      const limiter = createRateLimiter(app.tenancy.runner, clock);
      const client = ip();
      const rule = AUTH_RATE_LIMITS[scope].ip;
      for (let attempt = 0; attempt < rule.limit; attempt += 1) {
        await limiter.enforce(scope, { ip: client, email: email() }, `${scope}-i-${attempt}`);
      }
      const refused = await refusal(
        limiter.enforce(scope, { ip: client, email: email() }, `${scope}-i-over`),
      );
      expect(refused.retryAfterSeconds).toBe(expectedRetryAfter(now, rule.windowSeconds));
      // Another client is unaffected.
      await limiter.enforce(scope, { ip: ip(), email: email() }, `${scope}-i-other`);
    },
  );
});

describe('key normalisation and counting rules', () => {
  it('counts every spelling of one address (case, surrounding whitespace) against one counter', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const local = `mixed-${randomUUID().slice(0, 8)}`;
    const variants = [
      `${local}@example.invalid`,
      `${local.toUpperCase()}@EXAMPLE.INVALID`,
      `  ${local}@Example.Invalid  `,
      `\t${local}@example.invalid\n`,
      `${local}@example.invalid`,
    ];
    expect(variants).toHaveLength(AUTH_RATE_LIMITS.sign_in.email.limit);
    for (const [index, variant] of variants.entries()) {
      await limiter.enforce('sign_in', { ip: ip(), email: variant }, `norm-${index}`);
    }
    await expect(
      limiter.enforce('sign_in', { ip: ip(), email: ` ${local}@EXAMPLE.invalid` }, 'norm-over'),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('bumps the IP counter on attempts the address limit refused, so rotating addresses still burns the IP budget', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const client = ip();
    const address = email();
    const { ip: ipRule, email: emailRule } = AUTH_RATE_LIMITS.sign_in;
    for (let attempt = 0; attempt < emailRule.limit; attempt += 1) {
      await limiter.enforce('sign_in', { ip: client, email: address }, `burn-ok-${attempt}`);
    }
    // Refused by the address limit, yet each still counts against the IP.
    for (let attempt = emailRule.limit; attempt < ipRule.limit; attempt += 1) {
      await expect(
        limiter.enforce('sign_in', { ip: client, email: address }, `burn-refused-${attempt}`),
      ).rejects.toBeInstanceOf(RateLimitedError);
    }
    const fresh = email();
    await expect(
      limiter.enforce('sign_in', { ip: client, email: fresh }, 'burn-ip-over'),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // The fresh address was bumped once by that refusal and is otherwise fine elsewhere.
    await limiter.enforce('sign_in', { ip: ip(), email: fresh }, 'burn-elsewhere');
  });

  it('bumps the address counter on attempts the IP limit refused', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const client = ip();
    const address = email();
    const { ip: ipRule, email: emailRule } = AUTH_RATE_LIMITS.magic_link;
    for (let attempt = 0; attempt < ipRule.limit; attempt += 1) {
      await limiter.enforce('magic_link', { ip: client, email: email() }, `ipburn-${attempt}`);
    }
    for (let attempt = 0; attempt < emailRule.limit; attempt += 1) {
      await expect(
        limiter.enforce('magic_link', { ip: client, email: address }, `ipburn-addr-${attempt}`),
      ).rejects.toBeInstanceOf(RateLimitedError);
    }
    // From a new IP the address is now over its own limit.
    await expect(
      limiter.enforce('magic_link', { ip: ip(), email: address }, 'ipburn-addr-over'),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('limits a blank or missing address on the IP key only', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const beyondEmailLimit = AUTH_RATE_LIMITS.sign_in.email.limit + 3;
    for (let attempt = 0; attempt < beyondEmailLimit; attempt += 1) {
      await limiter.enforce('sign_in', { ip: ip(), email: '' }, `blank-${attempt}`);
      await limiter.enforce('sign_in', { ip: ip(), email: '   ' }, `blank-ws-${attempt}`);
      await limiter.enforce('sign_in', { ip: ip() }, `blank-none-${attempt}`);
    }
    const client = ip();
    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.sign_in.ip.limit; attempt += 1) {
      await limiter.enforce('sign_in', { ip: client }, `blank-ip-${attempt}`);
    }
    await expect(
      limiter.enforce('sign_in', { ip: client }, 'blank-ip-over'),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('refuses from the first millisecond after the limit until the last millisecond of the window', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = email();
    const rule = AUTH_RATE_LIMITS.sign_in.email;
    const start = new Date('2026-11-04T12:00:00.000Z');
    now = start;
    for (let attempt = 0; attempt < rule.limit; attempt += 1) {
      await limiter.enforce('sign_in', { ip: ip(), email: address }, `edge-${attempt}`);
    }
    now = new Date(start.getTime() + rule.windowSeconds * 1000 - 1);
    const refused = await refusal(
      limiter.enforce('sign_in', { ip: ip(), email: address }, 'edge-last-ms'),
    );
    expect(refused.retryAfterSeconds).toBe(1);
    now = new Date(start.getTime() + rule.windowSeconds * 1000);
    await limiter.enforce('sign_in', { ip: ip(), email: address }, 'edge-next-window');
    now = new Date('2026-11-02T09:00:30Z');
  });
});

describe('concurrency', () => {
  it('30 simultaneous attempts for one address let through exactly the limit and count every attempt', async () => {
    // A wider pool so the attempts really overlap inside Postgres.
    const wide = await connectAppDb({ max: 10 });
    try {
      const limiter = createRateLimiter(wide.tenancy.runner, clock);
      const address = email();
      const { limit } = AUTH_RATE_LIMITS.sign_in.email;
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, index) =>
          limiter.enforce('sign_in', { ip: ip(), email: address }, `conc-${index}`),
        ),
      );
      const allowed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(allowed).toHaveLength(limit);
      expect(refused).toHaveLength(30 - limit);
      for (const r of refused) {
        expect(r.reason).toBeInstanceOf(RateLimitedError);
      }
      // One row for the address key in this window, holding all 30 hits (hash as the app computes it).
      const key = createHash('sha256')
        .update(`rebook-rate-limit:sign_in:email:${address}`, 'utf8')
        .digest('hex');
      const rows = await wide.tenancy.withAnonymousContext('conc-check', (tx) =>
        tx.db.execute<{ count: number }>(
          sql`select count from rebook.rate_limits where key = ${key}`,
        ),
      );
      expect(rows).toEqual([{ count: 30 }]);
    } finally {
      await wide.close();
    }
  });
});

describe('the stale-window sweep inside rebook.rate_limit_hit', () => {
  it('never removes a live counter of a longer window when a shorter-window scope sweeps', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = email();
    const signUp = AUTH_RATE_LIMITS.sign_up.email; // 3 per hour
    const base = new Date('2026-11-05T10:00:30Z'); // hour window 10:00–11:00
    const later = new Date(base.getTime() + 25 * 60_000); // 10:25:30, same hour window
    const probeKey = (index: number) =>
      createHash('sha256').update(`sweep-probe-${index}`, 'utf8').digest('hex');

    now = base;
    for (let attempt = 0; attempt < signUp.limit; attempt += 1) {
      await limiter.enforce('sign_up', { ip: ip(), email: address }, `sweep-su-${attempt}`);
    }

    // A burst of sign-in traffic (600 s windows) 25 minutes later. The 1 % sweep is driven by
    // random(); seeding makes the run deterministic. The probe key gets a genuinely stale row
    // first (three hours old) so the test can prove a sweep really happened.
    const seed = 0.42;
    const burst = 700;
    await app.tenancy.withAnonymousContext('sweep-burst', async (tx) => {
      await tx.db.execute(
        sql`select rebook.rate_limit_hit(${probeKey(0)}, 600, 20, ${new Date(base.getTime() - 3 * 3_600_000).toISOString()}::timestamptz)`,
      );
      await tx.db.execute(sql`select setseed(${seed})`);
      for (let index = 0; index < burst; index += 1) {
        await tx.db.execute(
          sql`select rebook.rate_limit_hit(${probeKey(index)}, 600, 20, ${later.toISOString()}::timestamptz)`,
        );
      }
    });
    const stale = await app.tenancy.withAnonymousContext('sweep-stale-check', (tx) =>
      tx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from rebook.rate_limits where key = ${probeKey(0)} and window_start < ${base.toISOString()}::timestamptz`,
      ),
    );
    expect(
      stale[0]?.n,
      `seed ${seed} with ${burst} hits produced no sweep; choose another seed`,
    ).toBe(0);

    // Still inside the same hour: the fourth sign-up attempt for the address must be refused.
    now = later;
    await expect(
      limiter.enforce('sign_up', { ip: ip(), email: address }, 'sweep-su-4th'),
    ).rejects.toBeInstanceOf(RateLimitedError);
    now = new Date('2026-11-02T09:00:30Z');
  });
});

describe('the sweep after the fix: per-row window length', () => {
  it('records each row own window length as the scope defines it', async () => {
    const limiter = createRateLimiter(app.tenancy.runner, clock);
    const address = email();
    await limiter.enforce('sign_up', { ip: ip(), email: address }, 'ws-1');
    await limiter.enforce('sign_in', { ip: ip(), email: address }, 'ws-2');
    const keyOf = (scope: string) =>
      createHash('sha256')
        .update(`rebook-rate-limit:${scope}:email:${address}`, 'utf8')
        .digest('hex');
    const rows = await app.tenancy.withAnonymousContext('ws-check', (tx) =>
      tx.db.execute<{ key: string; window_seconds: number; count: number }>(
        sql`select key, window_seconds, count from rebook.rate_limits where key in (${keyOf('sign_up')}, ${keyOf('sign_in')}) order by window_seconds`,
      ),
    );
    expect(rows).toEqual([
      {
        key: keyOf('sign_in'),
        window_seconds: AUTH_RATE_LIMITS.sign_in.email.windowSeconds,
        count: 1,
      },
      {
        key: keyOf('sign_up'),
        window_seconds: AUTH_RATE_LIMITS.sign_up.email.windowSeconds,
        count: 1,
      },
    ]);
  });

  it('sweeps only rows whose own window ended more than its own length ago, whatever window the sweeper uses', async () => {
    const at = new Date('2026-11-06T12:30:30Z');
    const minutesBefore = (minutes: number) =>
      new Date(at.getTime() - minutes * 60_000).toISOString();
    const keyOf = (label: string) =>
      createHash('sha256').update(`hygiene-${label}`, 'utf8').digest('hex');
    const seed = 0.42;
    const burst = 700;
    const rows = await app.tenancy.withAnonymousContext('hygiene', async (tx) => {
      // 600 s rows: window 12:00 (ended 12:10, more than 600 s ago → swept) and window 12:20
      // (ended 12:30, 30 s ago → kept).
      await tx.db.execute(
        sql`select rebook.rate_limit_hit(${keyOf('short-stale')}, 600, 20, ${minutesBefore(25)}::timestamptz)`,
      );
      await tx.db.execute(
        sql`select rebook.rate_limit_hit(${keyOf('short-recent')}, 600, 20, ${minutesBefore(5)}::timestamptz)`,
      );
      // 3600 s rows: window 11:00 (live until 12:00, grace until 13:00 → kept) and window 10:00
      // (ended 11:00, more than an hour ago → swept).
      await tx.db.execute(
        sql`select rebook.rate_limit_hit(${keyOf('long-live')}, 3600, 20, ${minutesBefore(50)}::timestamptz)`,
      );
      await tx.db.execute(
        sql`select rebook.rate_limit_hit(${keyOf('long-stale')}, 3600, 20, ${minutesBefore(130)}::timestamptz)`,
      );
      await tx.db.execute(sql`select setseed(${seed})`);
      for (let index = 0; index < burst; index += 1) {
        await tx.db.execute(
          sql`select rebook.rate_limit_hit(${keyOf(`sweeper-${index}`)}, 600, 20, ${at.toISOString()}::timestamptz)`,
        );
      }
      return tx.db.execute<{ key: string }>(
        sql`select key from rebook.rate_limits where key in (${keyOf('short-stale')}, ${keyOf('short-recent')}, ${keyOf('long-live')}, ${keyOf('long-stale')}, ${keyOf('sweeper-0')})`,
      );
    });
    const kept = new Set(rows.map((row) => row.key));
    expect(
      kept.has(keyOf('long-stale')),
      `seed ${seed} with ${burst} hits produced no sweep; choose another seed`,
    ).toBe(false);
    expect(kept.has(keyOf('short-stale'))).toBe(false);
    expect(kept.has(keyOf('short-recent'))).toBe(true);
    expect(kept.has(keyOf('long-live'))).toBe(true);
    expect(kept.has(keyOf('sweeper-0'))).toBe(true);
  });
});
