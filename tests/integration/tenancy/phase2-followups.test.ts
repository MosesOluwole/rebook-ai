import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, FOREIGN_KEY_VIOLATION } from '../../helpers/sql-state';
import {
  actorFor,
  contextFor,
  createAuthUser,
  removeAuthUsers,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Phase 2 acceptance criterion 1, the Phase 1 follow-ups that live in the database: the
 * memberships select policy's actor branch is user-only, and memberships reference auth.users.
 * (The migration-immutability check and the time zone rule have their own tests.)
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'fu');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('tenant_memberships select policy, actor branch', () => {
  it('shows a user their own membership in another tenant', async () => {
    // Control: the user path still works. Tenant B's owner acting in tenant B sees B's rows.
    const ctx = await app.tenancy.resolveTenantForUser(pair.b.slug, actorFor(pair.b));
    const rows = await app.tenancy.withTenant(ctx, (tx) =>
      tx.db.execute<{ user_id: string }>(
        sql`select user_id from rebook.tenant_memberships where user_id = ${pair.b.userId}`,
      ),
    );
    expect(rows.map((row) => row.user_id)).toEqual([pair.b.userId]);
  });

  it.each(['customer', 'worker', 'system'] as const)(
    'shows a %s actor whose id equals a user id none of that user memberships',
    async (actorKind) => {
      const ctx = contextFor(pair.a.id, { actorKind, actorId: pair.b.userId });
      const run = actorKind === 'worker' ? app.tenancy.withWorkerTenant : app.tenancy.withTenant;
      const rows = await run(ctx, (tx) =>
        tx.db.execute(
          sql`select 1 from rebook.tenant_memberships where user_id = ${pair.b.userId}`,
        ),
      );
      expect(rows).toHaveLength(0);
    },
  );

  it('does not extend to the tenants member branch for non-user actors either', async () => {
    const ctx = contextFor(pair.a.id, { actorKind: 'customer', actorId: pair.b.userId });
    const rows = await app.tenancy.withTenant(ctx, (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(rows.map((row) => row.id)).toEqual([pair.a.id]);
  });
});

describe('tenant_memberships.user_id → auth.users(id)', () => {
  it('rejects a membership for a user that does not exist with a foreign-key error', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.tenant_memberships (tenant_id, user_id, role) values (${pair.a.id}, ${randomUUID()}, 'staff')`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('removes the memberships of a deleted auth user (on delete cascade)', async () => {
    // Owner-only arrangement: a user with a staff membership in tenant A, then the account is
    // deleted the way Supabase Auth would delete it.
    const user = await createAuthUser(owner, 'leaver');
    await owner.sql`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.a.id}, ${user.id}, 'staff')
    `;
    const before = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute(sql`select 1 from rebook.tenant_memberships where user_id = ${user.id}`),
    );
    expect(before).toHaveLength(1);

    await removeAuthUsers(owner, [user.id]);

    const after = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute(sql`select 1 from rebook.tenant_memberships where user_id = ${user.id}`),
    );
    expect(after).toHaveLength(0);
  });

  it('keeps the inviter reference nullable: deleting the inviter keeps the invitation', async () => {
    const inviter = await createAuthUser(owner, 'inviter');
    const [row] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
      values (${pair.a.id}, ${`kept-${pair.a.slug}@example.invalid`}, 'staff', ${'c'.repeat(64)}, ${inviter.id}, now() + interval '1 day')
      returning id
    `;
    await removeAuthUsers(owner, [inviter.id]);
    const seen = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ invited_by: string | null }>(
        sql`select invited_by from rebook.tenant_invitations where id = ${row?.id ?? ''}`,
      ),
    );
    expect(seen).toEqual([{ invited_by: null }]);
  });
});
