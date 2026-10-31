import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { onboardingHooks } from '@/modules/booking';
import {
  locationsRepository,
  membershipsRepository,
  NotFoundError,
  SlugUnavailableError,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { sqlState } from '../../helpers/sql-state';
import {
  actorFor,
  createAuthUser,
  type FixtureUser,
  removeAuthUsers,
  removeTenants,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Phase 2 under concurrency (docs/phases.md Phase 2: "two businesses with the same name get
 * different slugs without errors"; "accepting twice creates one membership"). The sequential
 * cases live in onboarding.test.ts and invitations.test.ts; these run the same commands at the
 * same time on a pool wide enough for every call to hold its own connection, so the slug
 * collision really happens inside the database and the retry path is exercised for real.
 * Run repeatedly (the test engineer loops this file 20 times); any single failure is a failure.
 */

const PARALLELISM = 8;

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
const founders: FixtureUser[] = [];
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb({ max: PARALLELISM + 2 });
  pair = await seedTenantPair(owner, 'conc');
  for (let i = 0; i < PARALLELISM; i += 1) {
    founders.push(await createAuthUser(owner, `founder${i}`));
  }
});

afterAll(async () => {
  await removeTenants(owner, createdTenantIds);
  await pair.cleanup();
  await removeAuthUsers(
    owner,
    founders.map((user) => user.id),
  );
  await app.close();
  await owner.close();
});

describe('concurrent onboarding with one business name', () => {
  it(`gives ${PARALLELISM} simultaneous registrations distinct slugs, one tenant each, nothing partial`, async () => {
    const name = `Same Name Studio ${randomUUID().slice(0, 6)}`;
    const base = name.toLowerCase().replace(/ /g, '-');

    const results = await Promise.allSettled(
      founders.map((user) =>
        app.tenancy.completeOnboarding(
          { name, businessType: 'event_planner', timeZone: 'Europe/London' },
          actorFor(user),
        ),
      ),
    );

    const failures = results.filter((result) => result.status === 'rejected');
    expect(
      failures.map((failure) => ({
        name: (failure.reason as Error).name,
        message: (failure.reason as Error).message,
        sqlState: sqlState(failure.reason),
      })),
    ).toEqual([]);

    const tenants = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    createdTenantIds.push(...tenants.map((tenant) => tenant.id));
    expect(tenants).toHaveLength(PARALLELISM);

    const slugs = tenants.map((tenant) => tenant.slug);
    expect(new Set(slugs).size).toBe(PARALLELISM);
    expect(slugs.filter((slug) => slug === base)).toHaveLength(1);
    for (const slug of slugs) {
      expect(slug).toMatch(new RegExp(`^${base}(?:-[a-z0-9]{4})?$`));
    }
    expect(new Set(tenants.map((tenant) => tenant.id)).size).toBe(PARALLELISM);

    // Every founder owns exactly the tenant they created, with its one default location.
    for (const user of founders) {
      const mine = await app.tenancy.listMyTenants(actorFor(user));
      const created = mine.filter((item) => item.name === name);
      expect(created).toHaveLength(1);
      const ctx = await app.tenancy.resolveTenantForUser(created[0]?.slug ?? '', actorFor(user));
      expect(ctx.role).toBe('owner');
      const seen = await app.tenancy.withTenant(ctx, async (tx) => ({
        locations: await locationsRepository.list(tx),
        members: await membershipsRepository.listActive(tx),
      }));
      expect(seen.locations).toHaveLength(1);
      expect(seen.members).toHaveLength(1);
      expect(seen.members[0]?.userId).toBe(user.id);
    }

    // No tenant with that name exists beyond the ones returned, and none is missing children.
    const [counts] = await owner.sql<
      { tenants: number; without_location: number; without_member: number }[]
    >`
      select
        (select count(*) from rebook.tenants t where t.name = ${name})::int as tenants,
        (select count(*) from rebook.tenants t where t.name = ${name}
           and not exists (select 1 from rebook.locations l where l.tenant_id = t.id))::int as without_location,
        (select count(*) from rebook.tenants t where t.name = ${name}
           and not exists (select 1 from rebook.tenant_memberships m where m.tenant_id = t.id))::int as without_member
    `;
    expect(counts).toEqual({ tenants: PARALLELISM, without_location: 0, without_member: 0 });
  });

  it('a deterministic suffix under concurrency still never commits a partial tenant', async () => {
    // Every candidate collides for all but two callers; the losers must fail with the typed error
    // and leave no tenant, location or membership behind.
    const { completeOnboarding } = await import('@/modules/tenancy/application/onboarding');
    const { createUuidV7Generator } = await import('@/modules/tenancy');
    const name = `Fixed Suffix ${randomUUID().slice(0, 6)}`;
    const base = name.toLowerCase().replace(/ /g, '-');
    const ids = createUuidV7Generator({ now: () => new Date() });
    const attempted: string[] = [];
    const deps = {
      runner: app.tenancy.runner,
      ids: {
        newId: () => {
          const id = ids.newId();
          attempted.push(id);
          return id;
        },
      },
      slugSuffix: () => 'same',
      hooks: onboardingHooks,
    };
    const input = { name, businessType: 'other_timed', timeZone: 'UTC' };

    const results = await Promise.allSettled(
      founders.map((user) => completeOnboarding(deps, input, actorFor(user))),
    );
    const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const lost = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    createdTenantIds.push(...won.map((tenant) => tenant.id));

    expect(won.map((tenant) => tenant.slug).sort()).toEqual([base, `${base}-same`]);
    expect(lost).toHaveLength(PARALLELISM - 2);
    for (const error of lost) {
      expect(error).toBeInstanceOf(SlugUnavailableError);
      expect(sqlState(error)).toBeUndefined();
    }

    const wonIds = new Set(won.map((tenant) => tenant.id));
    const abandoned = attempted.filter((id) => !wonIds.has(id));
    expect(abandoned.length).toBeGreaterThan(0);
    const [leftovers] = await owner.sql<{ tenants: number; locations: number; members: number }[]>`
      select
        (select count(*) from rebook.tenants where id = any(${abandoned}::uuid[]))::int as tenants,
        (select count(*) from rebook.locations where tenant_id = any(${abandoned}::uuid[]))::int as locations,
        (select count(*) from rebook.tenant_memberships where tenant_id = any(${abandoned}::uuid[]))::int as members
    `;
    expect(leftovers).toEqual({ tenants: 0, locations: 0, members: 0 });
  });
});

describe('concurrent acceptance of one invitation', () => {
  it('creates exactly one membership and every caller gets the membership or a typed error', async () => {
    const invitee = await createAuthUser(owner, 'racer');
    founders.push(invitee);
    const ownerCtx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    const { token } = await app.tenancy.withTenant(ownerCtx, (tx) =>
      app.tenancy.createInvitation(tx, { email: invitee.email, role: 'staff' }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(invitee)),
      ),
    );

    const [count] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.tenant_memberships
      where tenant_id = ${pair.a.id} and user_id = ${invitee.id}
    `;
    expect(count?.n).toBe(1);

    const memberships = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(memberships.length).toBeGreaterThanOrEqual(1);
    expect(new Set(memberships.map((m) => m.id)).size).toBe(1);

    // Acceptance is idempotent, so every concurrent caller must get the membership back. A raw
    // driver error (SQLSTATE) or a NotFoundError for the addressee is a bug.
    const rejections = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as unknown] : [],
    );
    expect(
      rejections.map((error) => ({
        name: (error as Error).name,
        message: (error as Error).message,
        sqlState: sqlState(error),
        notFound: error instanceof NotFoundError,
      })),
    ).toEqual([]);
    expect(memberships).toHaveLength(4);
  });
});
