import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTeamMember,
  getTeamMember,
  getWorkingHours,
  listTeamMembers,
  replaceWorkingHours,
  updateTeamMember,
} from '@/modules/booking';
import { NotFoundError, revokeMember, type TenantTx } from '@/modules/tenancy';
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
 * Test-engineer additions (Phase 3 decisions, item 2): the life of the link between a team member
 * and a membership beyond what team-membership.test.ts covers.
 *
 * - Deleting the auth user (which cascades to the membership) keeps the team member, its tenant
 *   and its hours, and nulls only the link (team_members_membership_fk, ON DELETE SET NULL
 *   (membership_id)), proven through the real cascade from auth.users.
 * - A revoked membership cannot be linked again, neither to a new team member nor to the one it
 *   was unlinked from.
 * - Concurrent onboarding by different users gives each business exactly one team member, linked
 *   to its own owner membership.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
const users: FixtureUser[] = [];
const tenants: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb({ max: 6 });
  pair = await seedTenantPair(owner, 'tm-life');
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

async function asOwner<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
  return app.tenancy.withTenant(ctx, work);
}

async function staffMembership(user: FixtureUser): Promise<string> {
  const [row] = await owner.sql<{ id: string }[]>`
    insert into rebook.tenant_memberships (tenant_id, user_id, role)
    values (${pair.a.id}, ${user.id}, 'staff') returning id
  `;
  if (row === undefined) {
    throw new Error('fixture: staff membership');
  }
  return row.id;
}

describe('the auth user behind a linked membership is deleted', () => {
  it('keeps the team member in its tenant with its hours; only the link is nulled', async () => {
    const user = await createAuthUser(owner, 'tm-gone');
    const membershipId = await staffMembership(user);
    const member = await asOwner((tx) =>
      createTeamMember(tx, { displayName: 'Leaving Staff', membershipId }),
    );
    await asOwner((tx) =>
      replaceWorkingHours(tx, member.id, pair.a.locationId, {
        days: { '4': { ranges: [{ start: '08:00', end: '12:00' }] } },
      }),
    );

    await removeAuthUsers(owner, [user.id]);

    const [gone] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.tenant_memberships where id = ${membershipId}
    `;
    expect(gone?.n).toBe(0);
    expect(await asOwner((tx) => getTeamMember(tx, member.id))).toMatchObject({
      id: member.id,
      tenantId: pair.a.id,
      membershipId: null,
      displayName: 'Leaving Staff',
    });
    expect(
      (await asOwner((tx) => getWorkingHours(tx, member.id))).map((r) => [r.weekday, r.start]),
    ).toEqual([[4, 480]]);
  });
});

describe('a revoked membership', () => {
  it('cannot be linked again, to a new team member or to the one it was unlinked from', async () => {
    const user = await createAuthUser(owner, 'tm-revoked');
    users.push(user);
    const membershipId = await staffMembership(user);
    const member = await asOwner((tx) =>
      createTeamMember(tx, { displayName: 'Revoked Staff', membershipId }),
    );
    await asOwner((tx) => revokeMember(tx, membershipId));
    expect((await asOwner((tx) => getTeamMember(tx, member.id))).membershipId).toBeNull();

    await expect(
      asOwner((tx) => createTeamMember(tx, { displayName: 'Again', membershipId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      asOwner((tx) =>
        updateTeamMember(tx, member.id, { displayName: 'Revoked Staff', membershipId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await asOwner((tx) => getTeamMember(tx, member.id))).membershipId).toBeNull();
  });
});

describe('concurrent onboarding by different users', () => {
  it('gives every new business exactly one team member, linked to its own owner membership', async () => {
    const owners = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createAuthUser(owner, `tm-conc-${String(i)}`)),
    );
    users.push(...owners);
    const created = await Promise.all(
      owners.map((user, i) =>
        app.tenancy.completeOnboarding(
          {
            name: `Concurrent Practice ${String(i)}`,
            businessType: i % 2 === 0 ? 'midwife' : 'event_planner',
            timeZone: 'Europe/London',
          },
          actorFor(user),
        ),
      ),
    );
    tenants.push(...created.map((tenant) => tenant.id));

    for (const [i, tenant] of created.entries()) {
      const user = owners[i];
      if (user === undefined) {
        throw new Error('fixture: owner');
      }
      const ctx = await app.tenancy.resolveTenantForUser(tenant.slug, actorFor(user));
      const members = await app.tenancy.withTenant(ctx, (tx) => listTeamMembers(tx));
      const [membership] = await owner.sql<{ id: string }[]>`
        select id from rebook.tenant_memberships where tenant_id = ${tenant.id} and user_id = ${user.id}
      `;
      expect(members, tenant.slug).toHaveLength(1);
      expect(members[0], tenant.slug).toMatchObject({
        tenantId: tenant.id,
        membershipId: membership?.id,
        displayName: `Concurrent Practice ${String(i)}`,
      });
    }
  });
});
