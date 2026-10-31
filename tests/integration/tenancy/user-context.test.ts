import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  contextFor,
  createAuthUser,
  type FixtureUser,
  removeAuthUsers,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * withUserContext and the one repository that accepts a UserTx: "list my memberships"
 * (docs/phases.md Phase 2). The tenant switcher must list exactly the user's own active
 * memberships, with the tenant names and slugs, and nothing about any other tenant.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
let stranger: FixtureUser;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'uc');
  stranger = await createAuthUser(owner, 'stranger');
  // Owner-only arrangement: tenant A's owner is also staff in tenant B.
  await owner.sql`
    insert into rebook.tenant_memberships (tenant_id, user_id, role)
    values (${pair.b.id}, ${pair.a.userId}, 'staff')
  `;
});

afterAll(async () => {
  await pair.cleanup();
  await removeAuthUsers(owner, [stranger.id]);
  await app.close();
  await owner.close();
});

describe('listMyTenants', () => {
  it('lists the user active memberships with slug, name, business type and role', async () => {
    const mine = await app.tenancy.listMyTenants(actorFor(pair.a));
    expect(mine).toEqual(
      [
        {
          tenantId: pair.a.id,
          slug: pair.a.slug,
          name: pair.a.name,
          businessType: 'other_timed',
          role: 'owner',
        },
        {
          tenantId: pair.b.id,
          slug: pair.b.slug,
          name: pair.b.name,
          businessType: 'other_timed',
          role: 'staff',
        },
      ].sort((x, y) => x.name.localeCompare(y.name)),
    );
  });

  it('lists only the inviting tenant for a single-tenant member, and nothing for a stranger', async () => {
    expect(await app.tenancy.listMyTenants(actorFor(pair.b))).toEqual([
      {
        tenantId: pair.b.id,
        slug: pair.b.slug,
        name: pair.b.name,
        businessType: 'other_timed',
        role: 'owner',
      },
    ]);
    expect(await app.tenancy.listMyTenants(actorFor(stranger))).toEqual([]);
  });

  it('drops a membership once it is revoked', async () => {
    const user = await createAuthUser(owner, 'revoked');
    const [membership] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.a.id}, ${user.id}, 'staff') returning id
    `;
    expect(await app.tenancy.listMyTenants(actorFor(user))).toHaveLength(1);
    await owner.sql`update rebook.tenant_memberships set revoked_at = now() where id = ${membership?.id ?? ''}`;
    expect(await app.tenancy.listMyTenants(actorFor(user))).toEqual([]);
    await removeAuthUsers(owner, [user.id]);
  });
});

describe('what a user context can and cannot see', () => {
  it('sees the tenants it is a member of and no other tenant row', async () => {
    const rows = await app.tenancy.withUserContext(actorFor(pair.a), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(rows.map((row) => row.id).sort()).toEqual([pair.a.id, pair.b.id].sort());

    const none = await app.tenancy.withUserContext(actorFor(stranger), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(none).toEqual([]);
  });

  it('sees only its own membership rows, never another user of the same tenant', async () => {
    const rows = await app.tenancy.withUserContext(actorFor(pair.a), (tx) =>
      tx.db.execute<{ user_id: string }>(sql`select user_id from rebook.tenant_memberships`),
    );
    expect(rows.every((row) => row.user_id === pair.a.userId)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('cannot write anything: inserts into any tenant table are denied without a tenant', async () => {
    const attempt = app.tenancy.withUserContext(actorFor(pair.a), (tx) =>
      tx.db.execute(
        sql`insert into rebook.locations (tenant_id, name, time_zone) values (${pair.a.id}, 'Sneaky', 'Europe/London')`,
      ),
    );
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }) as unknown,
    });
  });

  it('inside tenant A context a user who is also a member of B sees only A row; the switcher (no tenant) lists both', async () => {
    const asOwner = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    const visible = await app.tenancy.withTenant(asOwner, (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(visible.map((row) => row.id)).toEqual([pair.a.id]);

    const switcher = await app.tenancy.listMyTenants(actorFor(pair.a));
    expect(switcher.map((row) => row.tenantId).sort()).toEqual([pair.a.id, pair.b.id].sort());

    const asSystem = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(asSystem.map((row) => row.id)).toEqual([pair.a.id]);
  });
});

// ---- Follow-up verification (test engineer): tenants_select_member is off inside a tenant ----

describe('tenants_select_member applies only while no tenant is set', () => {
  it('catalogue: the policy predicate requires app.tenant_id to be empty and the actor to be a user', async () => {
    const [policy] = await owner.sql<{ qual: string | null; cmd: string; roles: string[] }[]>`
      select pg_get_expr(p.polqual, p.polrelid) as qual,
             p.polcmd::text as cmd,
             array(select rolname::text from pg_roles where oid = any(p.polroles)) as roles
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'rebook' and c.relname = 'tenants' and p.polname = 'tenants_select_member'
    `;
    expect(policy).toBeDefined();
    expect(policy?.cmd).toBe('r');
    expect(policy?.roles).toEqual(['rebook_app']);
    expect(policy?.qual).toContain("= 'user'::text");
    expect(policy?.qual).toMatch(
      /NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)[^)]*\) IS NULL/,
    );
    expect(policy?.qual).toContain('m.revoked_at IS NULL');
  });

  it('inside tenant A, a user actor who is a member of B only sees A row and never B', async () => {
    // Tenant B's owner is not a member of A. Installing them as the user actor inside A's context
    // (as rebook_app, in the same transaction) must not open B's row: the member branch is off.
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), async (tx) => {
      await tx.db.execute(sql`
        select set_config('app.actor_kind', 'user', true),
               set_config('app.actor_id', ${pair.b.userId}, true)
      `);
      return tx.db.execute<{ id: string }>(sql`select id from rebook.tenants order by id`);
    });
    expect(rows.map((row) => row.id)).toEqual([pair.a.id]);

    // Control: with no tenant set the same user sees B through the member branch.
    const mine = await app.tenancy.withUserContext(actorFor(pair.b), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(mine.map((row) => row.id)).toEqual([pair.b.id]);
  });

  it('inside tenant A, selecting B by id or slug as a member of both returns nothing', async () => {
    const asOwner = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    const [byId, bySlug, count] = await app.tenancy.withTenant(asOwner, (tx) =>
      Promise.all([
        tx.db.execute(sql`select id from rebook.tenants where id = ${pair.b.id}`),
        tx.db.execute(sql`select id from rebook.tenants where slug = ${pair.b.slug}`),
        tx.db.execute<{ n: number }>(sql`select count(*)::int as n from rebook.tenants`),
      ]),
    );
    expect(byId).toHaveLength(0);
    expect(bySlug).toHaveLength(0);
    expect(count).toEqual([{ n: 1 }]);
  });
});
