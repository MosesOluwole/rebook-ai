import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { listRebookTables, type RebookTable } from '../../helpers/catalogue';
import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, PERMISSION_DENIED } from '../../helpers/sql-state';
import {
  actorFor,
  type ConfiguredTenant,
  type ConfiguredTenantPair,
  contextFor,
  seedConfiguredTenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Extra isolation probes for the Phase 1 gate, extended in Phase 2. They complement isolation.generated.test.ts with
 * the cases that suite does not cover:
 *
 * - the same checks as rebook_worker (the policies name both runtime roles);
 * - reads, updates and deletes of tenant B's rows addressed by primary key, not by tenant_id
 *   (the existence-oracle case);
 * - a user who legitimately holds memberships in A and B cannot change or revoke the B one from
 *   tenant A's context, nor insert into B;
 * - a transaction with no context installed (on a fresh backend or one a tenant transaction
 *   used before, as behind a pooler) reads no tenant and returns zero rows for every table;
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
  tenant_invitations: sql`role = 'staff'`,
  audit_logs: sql`action = 'touched.row'`,
  tenant_feature_flags: sql`enabled = false`,
  idempotency_keys: sql`request_hash = 'touched'`,
  rate_limits: sql`count = 0`,
  services: sql`name = 'touched'`,
  team_members: sql`display_name = 'touched'`,
  staff_services: sql`created_at = now()`,
  working_hours: sql`end_time = '18:00'`,
  working_hour_breaks: sql`end_time = '12:30'`,
  availability_exceptions: sql`ends_at = ends_at + interval '1 hour'`,
  team_member_service_areas: sql`postcode_district = 'E1'`,
  daily_capacity_rules: sql`max_events_per_date = 1`,
  custom_field_definitions: sql`label = 'touched'`,
  custom_field_values: sql`value = '"Green"'::jsonb`,
};

/** Plain-SQL twin of `touch` for statements issued through postgres.js rather than drizzle. */
const touchLiteral: Readonly<Record<string, string>> = {
  tenants: "name = 'touched'",
  locations: "name = 'touched'",
  tenant_memberships: "role = 'staff'",
  tenant_invitations: "role = 'staff'",
  audit_logs: "action = 'touched.row'",
  tenant_feature_flags: 'enabled = false',
  idempotency_keys: "request_hash = 'touched'",
  rate_limits: 'count = 0',
  services: "name = 'touched'",
  team_members: "display_name = 'touched'",
  staff_services: 'created_at = now()',
  working_hours: "end_time = '18:00'",
  working_hour_breaks: "end_time = '12:30'",
  availability_exceptions: "ends_at = ends_at + interval '1 hour'",
  team_member_service_areas: "postcode_district = 'E1'",
  daily_capacity_rules: 'max_events_per_date = 1',
  custom_field_definitions: "label = 'touched'",
  custom_field_values: 'value = \'"Green"\'::jsonb',
};

/** The seeded primary key of a tenant in each table that has an `id` column. */
function seededIdIn(table: string, seed: ConfiguredTenant): string {
  const ids: Record<string, string> = {
    tenants: seed.id,
    locations: seed.locationId,
    tenant_memberships: seed.membershipId,
    tenant_invitations: seed.invitationId,
    audit_logs: seed.auditLogId,
    idempotency_keys: seed.idempotencyKeyId,
    services: seed.serviceId,
    team_members: seed.teamMemberId,
    working_hours: seed.workingHoursId,
    working_hour_breaks: seed.workingHourBreakId,
    availability_exceptions: seed.exceptionId,
    daily_capacity_rules: seed.capacityRuleId,
    custom_field_definitions: seed.customFieldDefinitionId,
    custom_field_values: seed.customFieldValueId,
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
function sampleInsert(table: string, seed: ConfiguredTenant): ReturnType<typeof sql> {
  switch (table) {
    case 'locations':
      return sql`insert into rebook.locations (tenant_id, name, time_zone) values (${seed.id}, 'Probe', 'Europe/London')`;
    case 'tenant_memberships':
      return sql`insert into rebook.tenant_memberships (tenant_id, user_id, role) values (${seed.id}, ${seed.spareUserId}, 'staff')`;
    case 'tenant_invitations':
      return sql`insert into rebook.tenant_invitations (tenant_id, email, role, token_hash, expires_at) values (${seed.id}, ${`worker-${seed.slug}@example.invalid`}, 'staff', ${'b'.repeat(64)}, now() + interval '1 minute')`;
    case 'audit_logs':
      return sql`insert into rebook.audit_logs (tenant_id, actor_kind, action, entity_type) values (${seed.id}, 'worker', 'probe.insert', 'probe')`;
    case 'tenant_feature_flags':
      return sql`insert into rebook.tenant_feature_flags (tenant_id, flag, enabled) values (${seed.id}, 'worker_probe', true)`;
    case 'idempotency_keys':
      return sql`insert into rebook.idempotency_keys (tenant_id, scope, key, request_hash, expires_at) values (${seed.id}, 'probe', ${`worker-${seed.slug}`}, 'h', now() + interval '1 minute')`;
    default:
      // The Phase 3 configuration tables grant the worker SELECT only, so the privilege check
      // refuses any insert before a row is built. If the worker ever gains INSERT here, this
      // statement fails differently (NOT NULL) and the table needs a real sample row.
      return sql`insert into rebook.${sql.identifier(table)} default values`;
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
let pair: ConfiguredTenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedConfiguredTenantPair(owner, 'probe');
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

  it('grants each runtime role exactly the privileges the design gives it', () => {
    const all = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    const expected: Record<string, { app: string[]; worker: string[] }> = {
      audit_logs: { app: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'] },
      idempotency_keys: { app: all, worker: all },
      locations: { app: all, worker: all },
      tenant_feature_flags: { app: all, worker: all },
      // Invitations are created, accepted and revoked by the app; the worker only reads them
      // (invitation emails, Phase 6). Nothing deletes them.
      tenant_invitations: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'] },
      tenant_memberships: { app: all, worker: all },
      // Owners edit business settings (Phase 2); jobs never do. Nobody deletes a tenant.
      tenants: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'INSERT'] },
      // Platform-level counters for rate limiting (no tenant_id): the app alone, incl. sweeping.
      rate_limits: { app: all, worker: [] },
      // Phase 3 configuration: the back office edits it; jobs only read it.
      services: { app: all, worker: ['SELECT'] },
      team_members: { app: all, worker: ['SELECT'] },
      staff_services: { app: all, worker: ['SELECT'] },
      working_hours: { app: all, worker: ['SELECT'] },
      working_hour_breaks: { app: all, worker: ['SELECT'] },
      availability_exceptions: { app: all, worker: ['SELECT'] },
      team_member_service_areas: { app: all, worker: ['SELECT'] },
      daily_capacity_rules: { app: all, worker: ['SELECT'] },
      custom_field_definitions: { app: all, worker: ['SELECT'] },
      custom_field_values: { app: all, worker: ['SELECT'] },
    };
    expect(Object.fromEntries(appTables.map((t) => [t.table, t.appPrivileges]))).toEqual(
      Object.fromEntries(Object.entries(expected).map(([table, p]) => [table, p.app])),
    );
    expect(Object.fromEntries(workerTables.map((t) => [t.table, t.appPrivileges]))).toEqual(
      Object.fromEntries(Object.entries(expected).map(([table, p]) => [table, p.worker])),
    );
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

  // The production path: slug plus active membership → AuthorisedTenantContext.
  const asUserInA = () => app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));

  it('can see its own tenant B membership (so Phase 2 can list a user tenants)', async () => {
    const rows = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute<{ tenant_id: string }>(
        sql`select tenant_id from rebook.tenant_memberships where id = ${membershipInB}`,
      ),
    );
    expect(rows.map((row) => row.tenant_id)).toEqual([pair.b.id]);
  });

  it('updates zero rows when it tries to promote or revoke that tenant B membership', async () => {
    const promoted = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute(
        sql`update rebook.tenant_memberships set role = 'owner' where id = ${membershipInB} returning 1`,
      ),
    );
    expect(promoted).toHaveLength(0);

    const revoked = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute(
        sql`update rebook.tenant_memberships set revoked_at = now() where user_id = ${pair.a.userId} and tenant_id = ${pair.b.id} returning 1`,
      ),
    );
    expect(revoked).toHaveLength(0);

    const stillStaff = await app.tenancy.withTenant(
      await app.tenancy.resolveTenantForUser(pair.b.slug, actorFor(pair.a)),
      (tx) =>
        tx.db.execute<{ role: string; revoked_at: string | null }>(
          sql`select role, revoked_at from rebook.tenant_memberships where id = ${membershipInB}`,
        ),
    );
    expect(stillStaff).toEqual([{ role: 'staff', revoked_at: null }]);
  });

  it('deletes zero rows when it tries to delete that tenant B membership', async () => {
    const rows = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute(
        sql`delete from rebook.tenant_memberships where id = ${membershipInB} returning 1`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot insert a membership into tenant B for anyone', async () => {
    await expectSqlState(
      app.tenancy.withTenant(await asUserInA(), (tx) =>
        tx.db.execute(
          sql`insert into rebook.tenant_memberships (tenant_id, user_id, role) values (${pair.b.id}, ${pair.a.spareUserId}, 'owner')`,
        ),
      ),
      PERMISSION_DENIED,
    );
  });

  it('sees no other user of tenant B', async () => {
    const rows = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute<{ user_id: string }>(
        sql`select user_id from rebook.tenant_memberships where tenant_id = ${pair.b.id}`,
      ),
    );
    expect(rows.map((row) => row.user_id)).toEqual([pair.a.userId]);
  });

  it('sees only tenant A row inside tenant A context, even though it is a member of B', async () => {
    // Phase 2: the member branch of the tenants policy applies only while no tenant is set
    // (the switcher's user context); inside a tenant context the current tenant is all there is.
    const rows = await app.tenancy.withTenant(await asUserInA(), (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.tenants order by id`),
    );
    expect(rows.map((row) => row.id)).toEqual([pair.a.id]);

    const stranger = await app.tenancy.withTenant(
      await app.tenancy.resolveTenantForUser(pair.b.slug, actorFor(pair.b)),
      (tx) => tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
    );
    expect(stranger.map((row) => row.id)).toEqual([pair.b.id]);
  });
});

describe('a transaction with no context installed', () => {
  // Written to hold behind a transaction pooler as well as locally. A pooler hands out backends
  // that earlier clients used, and a setting once set reads back as '' (not NULL) on such a
  // backend, so the probe asserts the form the policies use, nullif(…, ''), never "is null" on
  // the raw setting. It runs twice on one pooled connection: before any context was installed
  // there and after a tenant A transaction, so both readings are covered on every run.
  it('reads no tenant and sees zero rows in every tenant-scoped table, without an error', async () => {
    const single = await connectAppDb({ max: 1 });
    try {
      // Every tenant-scoped table (tenants included). Platform tables without tenant_id
      // (rate_limits) are readable by design and are covered by the platform tests.
      const tenantScoped = appTables.filter((t) => t.hasTenantId || t.table === 'tenants');
      expect(tenantScoped.length).toBe(appTables.length - 1);

      const probe = async (when: string) => {
        const [state] = await single.client.sql.begin(async (tx) => {
          await tx`set local role rebook_app`;
          return tx<{ no_tenant: boolean }[]>`
            select nullif(current_setting('app.tenant_id', true), '') is null as no_tenant
          `;
        });
        expect(state?.no_tenant, when).toBe(true);
        for (const { table } of tenantScoped) {
          const [row] = await single.client.sql.begin(async (tx) => {
            await tx`set local role rebook_app`;
            return tx<{ n: number }[]>`select count(*)::int as n from rebook.${tx(table)}`;
          });
          expect(row?.n, `${when}: rebook.${table}`).toBe(0);
        }
      };

      await probe('before any context on this connection');
      const seen = await single.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute<{ n: number }>(sql`select count(*)::int as n from rebook.locations`),
      );
      expect(seen[0]?.n).toBeGreaterThan(0);
      await probe('after a tenant A transaction on the same connection');
    } finally {
      await single.close();
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
