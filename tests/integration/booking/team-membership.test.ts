import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addAvailabilityException,
  addOwnerAsTeamMember,
  createTeamMember,
  getTeamMember,
  getWorkingHours,
  listCurrentExceptions,
  listTeamMembers,
  replaceWorkingHours,
} from '@/modules/booking';
import {
  createTenancy,
  PermissionDeniedError,
  revokeMember,
  type TenantTx,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
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
 * Phase 3 decisions, item 2: onboarding creates a team member linked to the owner's membership,
 * in the onboarding transaction; revoking a membership keeps the team member (unlinked) with its
 * hours and time off.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
const users: FixtureUser[] = [];
const tenants: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'tm-link');
});

afterAll(async () => {
  await removeTenants(owner, tenants);
  await pair.cleanup();
  await removeAuthUsers(
    owner,
    users.map((user) => user.id),
  );
  await app.close();
  await owner.close();
});

const clock = { now: () => new Date() };

describe('onboarding', () => {
  it('creates the owner as the first team member, linked to their membership', async () => {
    const user = await createAuthUser(owner, 'onboard-tm');
    users.push(user);
    const tenant = await app.tenancy.completeOnboarding(
      { name: 'Linked Practice', businessType: 'midwife', timeZone: 'Europe/London' },
      actorFor(user),
    );
    tenants.push(tenant.id);

    const ctx = await app.tenancy.resolveTenantForUser(tenant.slug, actorFor(user));
    const members = await app.tenancy.withTenant(ctx, (tx) => listTeamMembers(tx));
    const [membership] = await owner.sql<{ id: string }[]>`
      select id from rebook.tenant_memberships where tenant_id = ${tenant.id} and user_id = ${user.id}
    `;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      displayName: 'Linked Practice',
      membershipId: membership?.id,
      active: true,
    });
  });

  it('leaves nothing behind when the hook fails: one transaction', async () => {
    const user = await createAuthUser(owner, 'onboard-fail');
    users.push(user);
    // Scoped to this run: a row left by an earlier, interrupted run cannot fail the test.
    const startedAt = new Date().toISOString();
    const failing = createTenancy(app.db, clock, {
      ownerJoined: () => Promise.reject(new Error('hook failed')),
    });
    await expect(
      failing.completeOnboarding(
        { name: 'Never Created', businessType: 'other_timed', timeZone: 'Europe/London' },
        actorFor(user),
      ),
    ).rejects.toThrow('hook failed');
    const [rows] = await owner.sql<{ tenants: number; memberships: number }[]>`
      select
        (select count(*)::int from rebook.tenants t
          where t.name = 'Never Created' and t.created_at >= ${startedAt}) as tenants,
        (select count(*)::int from rebook.tenant_memberships where user_id = ${user.id}) as memberships
    `;
    expect(rows).toEqual({ tenants: 0, memberships: 0 });
  });

  it('refuses the hook outside a registration grant (it is not a user command)', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    await expect(
      app.tenancy.withTenant(ctx, async (tx) => {
        const [tenant] = await owner.sql<
          { id: string; name: string; slug: string; business_type: string; time_zone: string }[]
        >`select * from rebook.tenants where id = ${pair.a.id}`;
        return addOwnerAsTeamMember(tx, {
          tenant: {
            id: pair.a.id,
            name: tenant?.name ?? '',
            slug: pair.a.slug,
            businessType: 'other_timed',
            timeZone: 'Europe/London',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          membership: {
            id: pair.a.membershipId,
            tenantId: pair.a.id,
            userId: pair.a.userId,
            role: 'owner',
            createdAt: new Date(),
            revokedAt: null,
          },
        });
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('revoking a membership', () => {
  async function asOwner<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    return app.tenancy.withTenant(ctx, work);
  }

  it('keeps the team member, unlinked, with its hours and time off', async () => {
    const [staff] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.a.id}, ${pair.a.spareUserId}, 'staff') returning id
    `;
    if (staff === undefined) {
      throw new Error('fixture: staff membership');
    }
    const member = await asOwner((tx) =>
      createTeamMember(tx, { displayName: 'Staff Member', membershipId: staff.id }),
    );
    const other = await asOwner((tx) =>
      createTeamMember(tx, { displayName: 'Owner Member', membershipId: pair.a.membershipId }),
    );
    await asOwner((tx) =>
      replaceWorkingHours(tx, member.id, pair.a.locationId, {
        days: { '2': { ranges: [{ start: '09:00', end: '13:00' }] } },
      }),
    );
    const exception = await asOwner((tx) =>
      addAvailabilityException(tx, {
        kind: 'time_off',
        teamMemberId: member.id,
        locationId: pair.a.locationId,
        startsAt: '2031-02-03T09:00',
        endsAt: '2031-02-04T17:00',
      }),
    );

    await asOwner((tx) => revokeMember(tx, staff.id));

    const after = await asOwner((tx) => getTeamMember(tx, member.id));
    expect(after).toMatchObject({ id: member.id, membershipId: null, displayName: 'Staff Member' });
    expect(
      (await asOwner((tx) => getWorkingHours(tx, member.id))).map((r) => [r.weekday, r.start]),
    ).toEqual([[2, 540]]);
    expect((await asOwner((tx) => listCurrentExceptions(tx, clock))).map((e) => e.id)).toContain(
      exception.id,
    );
    // Only the revoked membership's team member is unlinked.
    expect((await asOwner((tx) => getTeamMember(tx, other.id))).membershipId).toBe(
      pair.a.membershipId,
    );
  });
});
