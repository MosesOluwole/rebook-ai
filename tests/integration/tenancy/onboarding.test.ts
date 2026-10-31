import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLogsRepository,
  createUuidV7Generator,
  locationsRepository,
  membershipsRepository,
  SlugUnavailableError,
  tenantsRepository,
  ValidationError,
} from '@/modules/tenancy';
import { completeOnboarding } from '@/modules/tenancy/application/onboarding';
import { type DbClient } from '@/shared/db/client';
import { isUuidV7 } from '@/shared/kernel/uuid-v7';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  createAuthUser,
  type FixtureUser,
  removeAuthUsers,
  removeTenants,
} from '../../helpers/tenant-fixtures';

/**
 * Onboarding (docs/phases.md Phase 2): tenant, default location and owner membership in one
 * withTenant transaction with an app-generated id; two businesses with the same name get
 * different slugs without errors; nothing partial is ever left behind.
 */

let owner: DbClient;
let app: AppDb;
let user: FixtureUser;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  user = await createAuthUser(owner, 'founder');
});

afterAll(async () => {
  await removeTenants(owner, createdTenantIds);
  await removeAuthUsers(owner, [user.id]);
  await app.close();
  await owner.close();
});

const uniqueName = () => `Bloom Midwifery ${randomUUID().slice(0, 6)}`;

describe('completeOnboarding', () => {
  it('creates tenant, default location and owner membership in one transaction, audited', async () => {
    const actor = actorFor(user, { requestId: `onboard-${randomUUID()}` });
    const name = uniqueName();
    const tenant = await app.tenancy.completeOnboarding(
      { name: `  ${name} `, businessType: 'midwife', timeZone: 'europe/london' },
      actor,
    );
    createdTenantIds.push(tenant.id);

    expect(isUuidV7(tenant.id)).toBe(true);
    expect(tenant).toMatchObject({
      name,
      slug: name.toLowerCase().replace(/ /g, '-'),
      businessType: 'midwife',
      timeZone: 'Europe/London',
    });

    const ctx = await app.tenancy.resolveTenantForUser(tenant.slug, actor);
    expect(ctx.role).toBe('owner');
    const seen = await app.tenancy.withTenant(ctx, async (tx) => ({
      tenant: await tenantsRepository.findCurrent(tx),
      locations: await locationsRepository.list(tx),
      members: await membershipsRepository.listActive(tx),
      audit: await auditLogsRepository.listRecent(tx),
    }));
    expect(seen.tenant?.id).toBe(tenant.id);
    expect(seen.locations).toHaveLength(1);
    expect(seen.locations[0]).toMatchObject({ name, timeZone: 'Europe/London' });
    expect(seen.members).toHaveLength(1);
    expect(seen.members[0]).toMatchObject({ userId: user.id, role: 'owner', revokedAt: null });
    expect(seen.audit.map((entry) => entry.action).sort()).toEqual([
      'membership.created',
      'tenant.created',
    ]);
    expect(
      seen.audit.every(
        (entry) =>
          entry.actorKind === 'user' &&
          entry.actorId === user.id &&
          entry.requestId === actor.requestId,
      ),
    ).toBe(true);
    const created = seen.audit.find((entry) => entry.action === 'tenant.created');
    expect(created?.after).toMatchObject({
      slug: tenant.slug,
      businessType: 'midwife',
      timeZone: 'Europe/London',
      defaultLocationId: seen.locations[0]?.id,
    });

    expect(await app.tenancy.listMyTenants(actor)).toContainEqual({
      tenantId: tenant.id,
      slug: tenant.slug,
      name,
      businessType: 'midwife',
      role: 'owner',
    });
  });

  it('gives two businesses with the same name different slugs without errors', async () => {
    const name = uniqueName();
    const first = await app.tenancy.completeOnboarding(
      { name, businessType: 'event_planner', timeZone: 'UTC' },
      actorFor(user),
    );
    const second = await app.tenancy.completeOnboarding(
      { name, businessType: 'event_planner', timeZone: 'UTC' },
      actorFor(user),
    );
    createdTenantIds.push(first.id, second.id);

    expect(first.slug).toBe(name.toLowerCase().replace(/ /g, '-'));
    expect(second.slug).toMatch(new RegExp(`^${first.slug}-[a-z0-9]{4}$`));
    expect(first.id).not.toBe(second.id);
  });

  it('retries with a fresh id and leaves no partial rows when every slug candidate collides', async () => {
    const name = uniqueName();
    const base = name.toLowerCase().replace(/ /g, '-');
    const ids = createUuidV7Generator({ now: () => new Date() });
    const attemptedIds: string[] = [];
    const deps = {
      runner: app.tenancy.runner,
      ids: {
        newId: () => {
          const id = ids.newId();
          attemptedIds.push(id);
          return id;
        },
      },
      slugSuffix: () => 'zzzz',
    };
    const input = { name, businessType: 'other_timed', timeZone: 'UTC' };

    // Occupy both candidates the deterministic suffix can produce.
    const taken1 = await completeOnboarding(deps, input, actorFor(user));
    const taken2 = await completeOnboarding(deps, input, actorFor(user));
    createdTenantIds.push(taken1.id, taken2.id);
    expect([taken1.slug, taken2.slug]).toEqual([base, `${base}-zzzz`]);

    attemptedIds.length = 0;
    await expect(completeOnboarding(deps, input, actorFor(user))).rejects.toBeInstanceOf(
      SlugUnavailableError,
    );
    expect(attemptedIds).toHaveLength(5);

    // Nothing from the failed attempts exists: no tenant, location or membership with those ids.
    const [leftovers] = await owner.sql<{ tenants: number; locations: number; members: number }[]>`
      select
        (select count(*) from rebook.tenants where id = any(${attemptedIds}::uuid[]))::int as tenants,
        (select count(*) from rebook.locations where tenant_id = any(${attemptedIds}::uuid[]))::int as locations,
        (select count(*) from rebook.tenant_memberships where tenant_id = any(${attemptedIds}::uuid[]))::int as members
    `;
    expect(leftovers).toEqual({ tenants: 0, locations: 0, members: 0 });
  });

  it('rejects invalid input before touching the database', async () => {
    const [before] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.tenant_memberships where user_id = ${user.id}
    `;
    await expect(
      app.tenancy.completeOnboarding(
        { name: '', businessType: 'midwife', timeZone: 'Europe/London' },
        actorFor(user),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      app.tenancy.completeOnboarding(
        { name: 'Salon', businessType: 'salon', timeZone: 'Europe/London' },
        actorFor(user),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      app.tenancy.completeOnboarding(
        { name: 'Salon', businessType: 'midwife', timeZone: 'EST' },
        actorFor(user),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const [after] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.tenant_memberships where user_id = ${user.id}
    `;
    expect(after?.n).toBe(before?.n);
  });
});
