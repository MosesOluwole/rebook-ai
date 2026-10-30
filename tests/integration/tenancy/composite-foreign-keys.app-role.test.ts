import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { listCompositeForeignKeys } from '../../helpers/catalogue';
import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, FOREIGN_KEY_VIOLATION, PERMISSION_DENIED } from '../../helpers/sql-state';
import { contextFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/**
 * Phase 1 criterion: "Inserting a child row with tenant A and a tenant B parent fails with a
 * foreign-key error." No Phase 1 production table has a composite child yet (the first arrive in
 * Phase 3), so the pattern is proven here the way production will hit it: as
 * rebook_authenticator through withTenant, under forced RLS, on a probe child table that follows
 * the project pattern exactly (tenant_id, unique (tenant_id, id), composite FK to locations,
 * forced RLS, tenant policy, grants to the runtime roles).
 *
 * The probe table must be visible to a second connection, so it is committed and dropped again
 * in afterAll (and defensively in beforeAll). While it exists it satisfies every schema-check rule.
 */

const PROBE = 'zz_fk_probe_app_role';

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'fkapp');
  await owner.sql`drop table if exists rebook.${owner.sql(PROBE)}`;
  await owner.sql`
    create table rebook.${owner.sql(PROBE)} (
      id uuid primary key default rebook.uuid_generate_v7(),
      tenant_id uuid not null references rebook.tenants (id),
      location_id uuid not null,
      unique (tenant_id, id),
      foreign key (tenant_id, location_id) references rebook.locations (tenant_id, id)
    )
  `;
  await owner.sql`alter table rebook.${owner.sql(PROBE)} enable row level security`;
  await owner.sql`alter table rebook.${owner.sql(PROBE)} force row level security`;
  await owner.sql`
    create policy probe_tenant_isolation on rebook.${owner.sql(PROBE)}
      for all to rebook_app, rebook_worker
      using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
      with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  `;
  await owner.sql`grant select, insert on rebook.${owner.sql(PROBE)} to rebook_app, rebook_worker`;
});

afterAll(async () => {
  await owner.sql`drop table if exists rebook.${owner.sql(PROBE)}`;
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('composite foreign key through withTenant (rebook_app, forced RLS)', () => {
  it('accepts a tenant A child that points at a tenant A parent', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ tenant_id: string }>(
        sql`insert into rebook.${sql.identifier(PROBE)} (tenant_id, location_id) values (${pair.a.id}, ${pair.a.locationId}) returning tenant_id`,
      ),
    );
    expect(rows).toEqual([{ tenant_id: pair.a.id }]);
  });

  it('rejects a tenant A child that points at a tenant B parent with SQLSTATE 23503', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.${sql.identifier(PROBE)} (tenant_id, location_id) values (${pair.a.id}, ${pair.b.locationId})`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects a row tagged with tenant B before the foreign key is even consulted (RLS first)', async () => {
    // With a valid B parent the policy fails WITH CHECK (42501), so the FK never becomes an
    // oracle for whether tenant B's parent exists.
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.${sql.identifier(PROBE)} (tenant_id, location_id) values (${pair.b.id}, ${pair.b.locationId})`,
        ),
      ),
      PERMISSION_DENIED,
    );
  });

  it('behaves the same for rebook_worker', async () => {
    const ctx = contextFor(pair.a.id, { actorKind: 'worker', actorId: null });
    await expectSqlState(
      app.tenancy.withWorkerTenant(ctx, (tx) =>
        tx.db.execute(
          sql`insert into rebook.${sql.identifier(PROBE)} (tenant_id, location_id) values (${pair.a.id}, ${pair.b.locationId})`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('is discovered by the catalogue query the generated isolation suite relies on', async () => {
    // Phase 1 has no production composite key, so isolation.generated.test.ts currently runs
    // zero composite-key cases. This proves its discovery query will see one when Phase 3 adds
    // services and team members.
    const keys = await listCompositeForeignKeys(owner);
    expect(keys).toContainEqual({
      table: PROBE,
      name: `${PROBE}_tenant_id_location_id_fkey`,
      columns: ['tenant_id', 'location_id'],
      refTable: 'locations',
      refColumns: ['tenant_id', 'id'],
    });
  });

  it('left exactly one probe row, visible only to tenant A', async () => {
    const asA = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from rebook.${sql.identifier(PROBE)}`,
      ),
    );
    const asB = await app.tenancy.withTenant(contextFor(pair.b.id), (tx) =>
      tx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from rebook.${sql.identifier(PROBE)}`,
      ),
    );
    expect(asA[0]?.n).toBe(1);
    expect(asB[0]?.n).toBe(0);
  });
});
