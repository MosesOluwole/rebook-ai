import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { listRebookTables, type RebookTable } from '../../helpers/catalogue';
import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, PERMISSION_DENIED } from '../../helpers/sql-state';
import {
  contextFor,
  seedTenantPair,
  type SeededTenant,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Extra isolation probes for the Phase 1 gate. They complement isolation.generated.test.ts with
 * the cases that suite does not cover:
 *
 * - the same checks as rebook_worker (the policies name both runtime roles);
 * - reads, updates and deletes of tenant B's rows addressed by primary key, not by tenant_id
 *   (the existence-oracle case);
 * - a user who legitimately holds memberships in A and B cannot change or revoke the B one from
 *   tenant A's context, nor insert into B;
 * - a brand-new connection (setting never installed, reads back NULL rather than '') returns
 *   zero rows for every table;
 * - anon and authenticated are denied on writes, not only on reads;
 * - the login role can enter the two runtime roles and nothing else.
 *
 * Rows are seeded as the owner; every assertion runs as rebook_authenticator through withTenant
 * or withWorkerTenant, except the anon/authenticated attempts, which need the owner's membership
 * of those roles to SET ROLE into them.
 */

const touch: Readonly<Record<string, ReturnType<typeof sql>>> = {
  tenants: sql`name = 'touched'`,
  locations: sql`name = 'touched'`,
  tenant_memberships: sql`role = 'staff'`,
  audit_logs: sql`action = 'touched.row'`,
  tenant_feature_flags: sql`enabled = false`,
  idempotency_keys: sql`request_hash = 'touched'`,
};

/** Plain-SQL twin of `touch` for statements issued through postgres.js rather than drizzle. */
const touchLiteral: Readonly<Record<string, string>> = {
  tenants: "name = 'touched'",
  locations: "name = 'touched'",
  tenant_memberships: "role = 'staff'",
  audit_logs: "action = 'touched.row'",
  tenant_feature_flags: 'enabled = false',
  idempotency_keys: "request_hash = 'touched'",
};

/** The seeded primary key of a tenant in each table that has an `id` column. */
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

/** A minimal valid row per tenant-owned table, tagged with the given tenant. */
function sampleInsert(table: string, seed: SeededTenant): ReturnType<typeof sql> {
  switch (table) {
    case 'locations':
      return sql`insert into rebook.locations (tenant_id, name, time_zone) values (${seed.id}, 'Probe', 'Europe/London')`;
    case 'tenant_memberships':
      return sql`insert into rebook.tenant_memberships (tenant_id, user_id, role) values (${seed.id}, ${randomUUID()}, 'staff')`;
    case 'audit_logs':
      return sql`insert into rebook.audit_logs (tenant_id, actor_kind, action, entity_type) values (${seed.id}, 'worker', 'probe.insert', 'probe')`;
    case 'tenant_feature_flags':
      return sql`insert into rebook.tenant_feature_flags (tenant_id, flag, enabled) values (${seed.id}, 'worker_probe', true)`;
    case 'idempotency_keys':
      return sql`insert into rebook.idempotency_keys (tenant_id, scope, key, request_hash, expires_at) values (${seed.id}, 'probe', ${`worker-${seed.slug}`}, 'h', now() + interval '1 minute')`;
    default:
      throw new Error(`no sample insert for rebook.${table}; extend isolation.probes.test.ts`);
  }
}

function literalFor(table: string): string {
  const literal = touchLiteral[table];
  if (literal === undefined) {
    throw new Error(`no touch literal for rebook.${table}`);
  }
  return literal;
}

const catalogueOwner = await connectOwnerDb({ max: 1 });
const appTables: RebookTable[] = await listRebookTables(catalogueOwner, 'rebook_app');
const workerTables: RebookTable[] = await listRebookTables(catalogueOwner, 'rebook_worker');
await catalogueOwner.close();

const tenantTables = appTables.filter((table) => table.hasTenantId);
const workerTenantTables = workerTables.filter((table) => table.hasTenantId);

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'probe');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('catalogue coverage (probes)', () => {
  it('has a touch expression for every rebook table', () => {
    for (const table of appTables) {
      expect(touch, `touch[${table.table}]`).toHaveProperty(table.table);
      expect(touchLiteral, `touchLiteral[${table.table}]`).toHaveProperty(table.table);
    }
  });

  it('gives rebook_worker exactly the same privileges as rebook_app in Phase 1', () => {
    expect(workerTables).toEqual(appTables);
  });
});

describe.each(workerTenantTables)('rebook.$table as rebook_worker', ({ table, appPrivileges }) => {
  const workerCtx = () => contextFor(pair.a.id, { actorKind: 'worker', actorId: null });
  const canUpdate = appPrivileges.includes('UPDATE');
  const canDelete = appPrivileges.includes('DELETE');

  it('shows tenant A only rows with its own tenant_id, including its seeded row', async () => {
    const rows = await app.tenancy.withWorkerTenant(workerCtx(), (tx) =>
      tx.db.execute<{ tenant_id: string }>(
        sql`select tenant_id from rebook.${sql.identifier(table)}`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenant_id === pair.a.id)).toBe(true);
  });

  it('returns zero of tenant B rows even when asked for them by tenant_id', async () => {
    const rows = await app.tenancy.withWorkerTenant(workerCtx(), (tx) =>
      tx.db.execute(
        sql`select 1 from rebook.${sql.identifier(table)} where tenant_id = ${pair.b.id}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it(
    canUpdate ? 'updates zero of tenant B rows' : 'denies updates to the worker role entirely',
    async () => {
      const attempt = app.tenancy.withWorkerTenant(workerCtx(), (tx) =>
        tx.db.execute(
          sql`update rebook.${sql.identifier(table)} set ${touch[table]} where tenant_id = ${pair.b.id} returning 1`,
        ),
      );
      if (canUpdate) {
        expect(await attempt).toHaveLength(0);
      } else {
        await expectSqlState(attempt, PERMISSION_DENIED);
      }
    },
  );

  it(
    canDelete ? 'deletes zero of tenant B rows' : 'denies deletes to the worker role entirely',
    async () => {
      const attempt = app.tenancy.withWorkerTenant(workerCtx(), (tx) =>
        tx.db.execute(
          sql`delete from rebook.${sql.identifier(table)} where tenant_id = ${pair.b.id} returning 1`,
        ),
      );
      if (canDelete) {
        expect(await attempt).toHaveLength(0);
      } else {
        await expectSqlState(attempt, PERMISSION_DENIED);
      }
    },
  );

  it('rejects an insert tagged with tenant B', async () => {
    await expectSqlState(
      app.tenancy.withWorkerTenant(workerCtx(), (tx) => tx.db.execute(sampleInsert(table, pair.b))),
      PERMISSION_DENIED,
    );
  });
});

describe.each(tenantTables.filter((table) => table.hasId))(
  'rebook.$table addressed by primary key from tenant A',
  ({ table, appPrivileges }) => {
    it('returns zero rows for tenant B primary key (no existence oracle)', async () => {
      const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`select 1 from rebook.${sql.identifier(table)} where id = ${seededIdIn(table, pair.b)}`,
        ),
      );
      expect(rows).toHaveLength(0);
    });

    it('still returns tenant A own row by primary key', async () => {
      const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`select 1 from rebook.${sql.identifier(table)} where id = ${seededIdIn(table, pair.a)}`,
        ),
      );
      expect(rows).toHaveLength(1);
    });

    if (appPrivileges.includes('UPDATE')) {
      it('updates zero rows when tenant B primary key is targeted', async () => {
        const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
          tx.db.execute(
            sql`update rebook.${sql.identifier(table)} set ${touch[table]} where id = ${seededIdIn(table, pair.b)} returning 1`,
          ),
        );
        expect(rows).toHaveLength(0);
      });
    }

    if (appPrivileges.includes('DELETE')) {
      it('deletes zero rows when tenant B primary key is targeted', async () => {
        const rows = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
          tx.db.execute(
            sql`delete from rebook.${sql.identifier(table)} where id = ${seededIdIn(table, pair.b)} returning 1`,
          ),
        );
        expect(rows).toHaveLength(0);
      });
    }
  },
);

describe('a user with memberships in both tenants, acting in tenant A', () => {
  let membershipInB: string;

  beforeAll(async () => {
    // Owner-only arrangement: tenant A's user also holds a staff membership in tenant B.
    const [row] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.b.id}, ${pair.a.userId}, 'staff')
      returning id
    `;
    if (row === undefined) {
      throw new Error('fixture: membership insert returned no row');
    }
    membershipInB = row.id;
  });

  const asUserInA = () => contextFor(pair.a.id, { actorId: pair.a.userId });

  it('can see its own tenant B membership (so Phase 2 can list a user tenants)', async () => {
    const rows = await app.tenancy.withTenant(asUserInA(), (tx) =>
      tx.db.execute<{ tenant_id: string }>(
        sql`select tenant_id from rebook.tenant_memberships where id = ${membershipInB}`,
      ),
    );
    expect(rows.map((row) => row.tenant_id)).toEqual([pair.b.id]);
  });

  it('updates zero rows when it tries to promote or revoke that tenant B membership', async () => {
    const promoted = await app.tenancy.withTenant(asUserInA(), (tx) =>
      tx.db.execute(
        sql`update rebook.tenant_memberships set role = 'owner' where id = ${membershipInB} returning 1`,
      ),
    );
    expect(promoted).toHaveLength(0);

    const revoked = await app.tenancy.withTenant(asUserInA(), (tx) =>
      tx.db.execute(
        sql`update rebook.tenant_memberships set revoked_at = now() where user_id = ${pair.a.userId} and tenant_id = ${pair.b.id} returning 1`,
      ),
    );
    expect(revoked).toHaveLength(0);

    const stillStaff = await app.tenancy.withTenant(
      contextFor(pair.b.id, { actorId: pair.a.userId }),
      (tx) =>
        tx.db.execute<{ role: string; revoked_at: string | null }>(
          sql`select role, revoked_at from rebook.tenant_memberships where id = ${membershipInB}`,
        ),
    );
    expect(stillStaff).toEqual([{ role: 'staff', revoked_at: null }]);
  });

  it('deletes zero rows when it tries to delete that tenant B membership', async () => {
    const rows = await app.tenancy.withTenant(asUserInA(), (tx) =>
      tx.db.execute(
        sql`delete from rebook.tenant_memberships where id = ${membershipInB} returning 1`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot insert a membership into tenant B for anyone', async () => {
    await expectSqlState(
      app.tenancy.withTenant(asUserInA(), (tx) =>
        tx.db.execute(
          sql`insert into rebook.tenant_memberships (tenant_id, user_id, role) values (${pair.b.id}, ${randomUUID()}, 'owner')`,
        ),
      ),
      PERMISSION_DENIED,
    );
  });

  it('sees no other user of tenant B', async () => {
    const rows = await app.tenancy.withTenant(asUserInA(), (tx) =>
      tx.db.execute<{ user_id: string }>(
        sql`select user_id from rebook.tenant_memberships where tenant_id = ${pair.b.id}`,
      ),
    );
    expect(rows.map((row) => row.user_id)).toEqual([pair.a.userId]);
  });
});

describe('a brand-new connection with no context ever installed', () => {
  it('reads the setting as NULL and sees zero rows in every table, without an error', async () => {
    const fresh = await connectAppDb({ max: 1 });
    try {
      const [state] = await fresh.client.sql.begin(async (tx) => {
        await tx`set local role rebook_app`;
        return tx<{ never_set: boolean }[]>`
          select current_setting('app.tenant_id', true) is null as never_set
        `;
      });
      expect(state?.never_set).toBe(true);

      for (const { table } of appTables) {
        const [row] = await fresh.client.sql.begin(async (tx) => {
          await tx`set local role rebook_app`;
          return tx<{ n: number }[]>`select count(*)::int as n from rebook.${tx(table)}`;
        });
        expect(row?.n, table).toBe(0);
      }
    } finally {
      await fresh.close();
    }
  });
});

describe('Supabase Data API roles are denied on writes too', () => {
  it.each(['anon', 'authenticated'])(
    '%s cannot insert, update, delete or truncate',
    async (role) => {
      for (const { table } of appTables) {
        await expectSqlState(
          owner.sql.begin(async (tx) => {
            await tx`set local role ${tx(role)}`;
            return tx`insert into rebook.${tx(table)} default values`;
          }),
          PERMISSION_DENIED,
        );
        await expectSqlState(
          owner.sql.begin(async (tx) => {
            await tx`set local role ${tx(role)}`;
            return tx.unsafe(`update rebook.${table} set ${literalFor(table)}`);
          }),
          PERMISSION_DENIED,
        );
        await expectSqlState(
          owner.sql.begin(async (tx) => {
            await tx`set local role ${tx(role)}`;
            return tx`delete from rebook.${tx(table)}`;
          }),
          PERMISSION_DENIED,
        );
        await expectSqlState(
          owner.sql.begin(async (tx) => {
            await tx`set local role ${tx(role)}`;
            return tx`truncate rebook.${tx(table)}`;
          }),
          PERMISSION_DENIED,
        );
      }
    },
  );
});

describe('rebook_authenticator role switching', () => {
  it('can enter the two runtime roles and nothing else', async () => {
    for (const role of ['rebook_app', 'rebook_worker']) {
      const [row] = await app.client.sql.begin(async (tx) => {
        await tx`set local role ${tx(role)}`;
        return tx<{ who: string }[]>`select current_user::text as who`;
      });
      expect(row?.who).toBe(role);
    }
    for (const forbidden of [
      'rebook_platform',
      'postgres',
      'anon',
      'authenticated',
      'service_role',
    ]) {
      await expectSqlState(
        app.client.sql.begin(async (tx) => {
          await tx`set local role ${tx(forbidden)}`;
        }),
        PERMISSION_DENIED,
      );
    }
  });
});
