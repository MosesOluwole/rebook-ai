import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import {
  hasUniqueOn,
  listCompositeForeignKeys,
  listRebookTables,
  type CompositeForeignKey,
  type RebookTable,
} from '../../helpers/catalogue';
import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, FOREIGN_KEY_VIOLATION, PERMISSION_DENIED } from '../../helpers/sql-state';
import {
  contextFor,
  seedTenantPair,
  type SeededTenant,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Generated tenant-isolation suite (docs/phases.md Phase 1). The catalogue decides what is
 * tested: every table in `rebook` with a tenant_id column gets the same block, and every
 * composite foreign key gets a cross-tenant insert attempt. Rows are seeded as the owner
 * (tests/helpers/tenant-fixtures.ts); every assertion runs as rebook_authenticator through
 * withTenant. A new table without an entry in the maps below fails the suite on purpose.
 */

/** A harmless column change per table, used to prove updates to the other tenant hit zero rows. */
const touch: Readonly<Record<string, ReturnType<typeof sql>>> = {
  locations: sql`name = 'touched'`,
  tenant_memberships: sql`role = 'staff'`,
  audit_logs: sql`action = 'touched.row'`,
  tenant_feature_flags: sql`enabled = false`,
  idempotency_keys: sql`request_hash = 'touched'`,
};

/** A minimal valid row per table for the given tenant, used for cross-tenant insert attempts. */
const sampleRow: Readonly<
  Record<string, (tenantId: string, seed: SeededTenant) => Record<string, unknown>>
> = {
  locations: (tenantId) => ({ tenant_id: tenantId, name: 'Probe', time_zone: 'Europe/London' }),
  tenant_memberships: (tenantId) => ({
    tenant_id: tenantId,
    user_id: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f',
    role: 'staff',
  }),
  audit_logs: (tenantId) => ({
    tenant_id: tenantId,
    actor_kind: 'system',
    action: 'probe.insert',
    entity_type: 'probe',
  }),
  tenant_feature_flags: (tenantId) => ({ tenant_id: tenantId, flag: 'probe_flag', enabled: true }),
  idempotency_keys: (tenantId, seed) => ({
    tenant_id: tenantId,
    scope: 'probe',
    key: `probe-${seed.slug}`,
    request_hash: 'h',
    // Raw `sql` parameters are passed to the driver as-is, so dates travel as ISO strings.
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }),
};

/** The seeded row id of a tenant in a given table, for composite foreign key probes. */
function seededIdIn(table: string, seed: SeededTenant): string {
  const ids: Record<string, string> = {
    tenants: seed.id,
    locations: seed.locationId,
    tenant_memberships: seed.membershipId,
    audit_logs: seed.auditLogId,
    idempotency_keys: seed.idempotencyKeyId,
  };
  const id = ids[table];
  if (id === undefined) {
    throw new Error(
      `no seeded id known for rebook.${table}; extend tests/helpers/tenant-fixtures.ts`,
    );
  }
  return id;
}

function insertStatement(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return sql`insert into rebook.${sql.identifier(table)} (${sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `,
  )}) values (${sql.join(
    columns.map((column) => sql`${row[column]}`),
    sql`, `,
  )})`;
}

const catalogueOwner = await connectOwnerDb({ max: 1 });
const allTables: RebookTable[] = await listRebookTables(catalogueOwner);
const compositeForeignKeys: CompositeForeignKey[] = await listCompositeForeignKeys(catalogueOwner);
await catalogueOwner.close();

const tenantTables = allTables.filter((table) => table.hasTenantId);

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'iso');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('catalogue coverage', () => {
  it('found the Phase 1 tables', () => {
    expect(allTables.map((table) => table.table)).toEqual([
      'audit_logs',
      'idempotency_keys',
      'locations',
      'tenant_feature_flags',
      'tenant_memberships',
      'tenants',
    ]);
  });

  it('has a touch expression and a sample row for every tenant-owned table', () => {
    for (const table of tenantTables) {
      expect(touch, `touch[${table.table}]`).toHaveProperty(table.table);
      expect(sampleRow, `sampleRow[${table.table}]`).toHaveProperty(table.table);
    }
  });

  it.each(tenantTables.filter((table) => table.hasId))(
    'rebook.$table has unique (tenant_id, id) so children can reference it per tenant',
    async ({ table }) => {
      expect(await hasUniqueOn(owner, table, ['tenant_id', 'id'])).toBe(true);
    },
  );
});

describe.each(tenantTables)('rebook.$table', ({ table, appPrivileges }) => {
  const canUpdate = appPrivileges.includes('UPDATE');
  const canDelete = appPrivileges.includes('DELETE');

  it('shows tenant A only rows with its own tenant_id, including its seeded row', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ tenant_id: string }>(
        sql`select tenant_id from rebook.${sql.identifier(table)}`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenant_id === pair.a.id)).toBe(true);
  });

  it('returns zero of tenant B rows to tenant A even when asked for them by tenant_id', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute(
        sql`select 1 from rebook.${sql.identifier(table)} where tenant_id = ${pair.b.id}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it(
    canUpdate
      ? 'updates zero of tenant B rows from tenant A'
      : 'denies updates to the runtime role entirely',
    async () => {
      const statement = sql`update rebook.${sql.identifier(table)} set ${touch[table]} where tenant_id = ${pair.b.id} returning 1`;
      const attempt = app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(statement),
      );
      if (canUpdate) {
        expect(await attempt).toHaveLength(0);
      } else {
        await expectSqlState(attempt, PERMISSION_DENIED);
      }
    },
  );

  it(
    canDelete
      ? 'deletes zero of tenant B rows from tenant A'
      : 'denies deletes to the runtime role entirely',
    async () => {
      const statement = sql`delete from rebook.${sql.identifier(table)} where tenant_id = ${pair.b.id} returning 1`;
      const attempt = app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(statement),
      );
      if (canDelete) {
        expect(await attempt).toHaveLength(0);
      } else {
        await expectSqlState(attempt, PERMISSION_DENIED);
      }
    },
  );

  it('rejects an insert tagged with tenant B from tenant A context', async () => {
    const row = sampleRow[table]?.(pair.b.id, pair.b);
    if (row === undefined) {
      throw new Error(`no sample row for ${table}`);
    }
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(insertStatement(table, row)),
      ),
      PERMISSION_DENIED,
    );
  });

  it('returns zero rows and no error when no tenant context is set', async () => {
    const [row] = await app.client.sql.begin(async (tx) => {
      await tx`set local role rebook_app`;
      return tx<{ n: number }[]>`select count(*)::int as n from rebook.${tx(table)}`;
    });
    expect(row?.n).toBe(0);
  });

  it.each(compositeForeignKeys.filter((fk) => fk.table === table))(
    'rejects a row for tenant A that points at tenant B through $name',
    async (fk) => {
      const parentColumn = fk.columns.find((column) => column !== 'tenant_id');
      if (parentColumn === undefined) {
        throw new Error(`composite key ${fk.name} has no parent column`);
      }
      const base = sampleRow[table]?.(pair.a.id, pair.a) ?? {};
      const row = { ...base, [parentColumn]: seededIdIn(fk.refTable, pair.b) };
      await expectSqlState(
        app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
          tx.db.execute(insertStatement(table, row)),
        ),
        FOREIGN_KEY_VIOLATION,
      );
    },
  );
});

describe('rebook.tenants (the tenant row itself)', () => {
  it('shows tenant A exactly its own row', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(rows.map((row) => row.id)).toEqual([pair.a.id]);
  });

  it('returns zero rows for tenant B by id', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute(sql`select 1 from rebook.tenants where id = ${pair.b.id}`),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects inserting a tenant whose id is not the current tenant', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.tenants (id, name, slug, time_zone) values (${pair.b.id}, 'Imposter', ${`imposter-${pair.a.slug}`}, 'Europe/London')`,
        ),
      ),
      PERMISSION_DENIED,
    );
  });

  it('denies update and delete to the runtime role', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(sql`update rebook.tenants set name = 'x' where id = ${pair.a.id}`),
      ),
      PERMISSION_DENIED,
    );
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(sql`delete from rebook.tenants where id = ${pair.a.id}`),
      ),
      PERMISSION_DENIED,
    );
  });

  it('returns zero rows and no error when no tenant context is set', async () => {
    const [row] = await app.client.sql.begin(async (tx) => {
      await tx`set local role rebook_app`;
      return tx<{ n: number }[]>`select count(*)::int as n from rebook.tenants`;
    });
    expect(row?.n).toBe(0);
  });
});
