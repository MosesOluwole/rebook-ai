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
import {
  CHECK_VIOLATION,
  expectSqlState,
  FOREIGN_KEY_VIOLATION,
  PERMISSION_DENIED,
} from '../../helpers/sql-state';
import {
  type ConfiguredTenant,
  type ConfiguredTenantPair,
  contextFor,
  seedConfiguredTenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Generated tenant-isolation suite (docs/phases.md Phase 1, extended in Phases 2 and 3). The catalogue decides what is
 * tested: every table in `rebook` with a tenant_id column gets the same block, and every
 * composite foreign key gets a cross-tenant insert attempt. Rows are seeded as the owner
 * (tests/helpers/tenant-fixtures.ts); every assertion runs as rebook_authenticator through
 * withTenant. A new table without an entry in the maps below fails the suite on purpose.
 */

/** A harmless column change per table, used to prove updates to the other tenant hit zero rows. */
const touch: Readonly<Record<string, ReturnType<typeof sql>>> = {
  locations: sql`name = 'touched'`,
  tenant_memberships: sql`role = 'staff'`,
  tenant_invitations: sql`role = 'staff'`,
  audit_logs: sql`action = 'touched.row'`,
  tenant_feature_flags: sql`enabled = false`,
  idempotency_keys: sql`request_hash = 'touched'`,
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

/** A minimal valid row per table for the given tenant, used for cross-tenant insert attempts. */
const sampleRow: Readonly<
  Record<string, (tenantId: string, seed: ConfiguredTenant) => Record<string, unknown>>
> = {
  locations: (tenantId) => ({ tenant_id: tenantId, name: 'Probe', time_zone: 'Europe/London' }),
  // user_id must be a real auth user (foreign key); the spare user has no membership anywhere.
  tenant_memberships: (tenantId, seed) => ({
    tenant_id: tenantId,
    user_id: seed.spareUserId,
    role: 'staff',
  }),
  tenant_invitations: (tenantId, seed) => ({
    tenant_id: tenantId,
    email: `probe-${seed.slug}@example.invalid`,
    role: 'staff',
    token_hash: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
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
  // Phase 3. Each child row references the seeding tenant's own parents; the composite key
  // probes below swap one parent for tenant B's and expect the foreign key to refuse it.
  services: (tenantId) => ({
    tenant_id: tenantId,
    name: 'Probe',
    booking_mode: 'timed',
    duration_minutes: 30,
    price: '10.00',
    currency: 'GBP',
    location_type: 'clinic',
  }),
  team_members: (tenantId) => ({ tenant_id: tenantId, display_name: 'Probe' }),
  staff_services: (tenantId, seed) => ({
    tenant_id: tenantId,
    team_member_id: seed.teamMemberId,
    service_id: seed.serviceId,
  }),
  // Tuesday, so it never overlaps the seeded Monday range (working_hours_no_overlap).
  working_hours: (tenantId, seed) => ({
    tenant_id: tenantId,
    team_member_id: seed.teamMemberId,
    location_id: seed.locationId,
    weekday: 2,
    start_time: '09:00',
    end_time: '10:00',
  }),
  working_hour_breaks: (tenantId, seed) => ({
    tenant_id: tenantId,
    working_hours_id: seed.workingHoursId,
    start_time: '10:00',
    end_time: '10:15',
  }),
  // Time off rather than a closure: the team member key is then present, so swapping it for
  // tenant B's member reaches the foreign key instead of the kind/subject CHECK.
  availability_exceptions: (tenantId, seed) => ({
    tenant_id: tenantId,
    kind: 'time_off',
    team_member_id: seed.teamMemberId,
    location_id: seed.locationId,
    starts_at: '2031-03-03T09:00:00Z',
    ends_at: '2031-03-03T17:00:00Z',
  }),
  team_member_service_areas: (tenantId, seed) => ({
    tenant_id: tenantId,
    team_member_id: seed.teamMemberId,
    postcode_district: 'M1',
  }),
  daily_capacity_rules: (tenantId, seed) => ({
    tenant_id: tenantId,
    team_member_id: seed.teamMemberId,
    max_events_per_date: 3,
  }),
  custom_field_definitions: (tenantId) => ({
    tenant_id: tenantId,
    entity: 'service',
    key: 'probe_key',
    label: 'Probe',
    field_type: 'number',
  }),
  custom_field_values: (tenantId, seed) => ({
    tenant_id: tenantId,
    definition_id: seed.customFieldDefinitionId,
    entity: 'service',
    service_id: seed.serviceId,
    value: '"Green"',
  }),
};

/** The seeded row id of a tenant in a given table, for composite foreign key probes. */
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
let pair: ConfiguredTenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedConfiguredTenantPair(owner, 'iso');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('catalogue coverage', () => {
  it('found the Phase 1, 2 and 3 tables', () => {
    expect(allTables.map((table) => table.table)).toEqual([
      'audit_logs',
      'availability_exceptions',
      'custom_field_definitions',
      'custom_field_values',
      'daily_capacity_rules',
      'idempotency_keys',
      'locations',
      'rate_limits',
      'services',
      'staff_services',
      'team_member_service_areas',
      'team_members',
      'tenant_feature_flags',
      'tenant_invitations',
      'tenant_memberships',
      'tenants',
      'working_hour_breaks',
      'working_hours',
    ]);
  });

  it('found a composite key for every Phase 3 child of a tenant-owned parent', () => {
    expect(compositeForeignKeys.map((fk) => `${fk.table}.${fk.name}`).sort()).toEqual(
      expect.arrayContaining([
        'availability_exceptions.availability_exceptions_location_fk',
        'availability_exceptions.availability_exceptions_team_member_fk',
        'custom_field_values.custom_field_values_definition_fk',
        'custom_field_values.custom_field_values_service_fk',
        'daily_capacity_rules.daily_capacity_rules_team_member_fk',
        'staff_services.staff_services_service_fk',
        'staff_services.staff_services_team_member_fk',
        'team_member_service_areas.team_member_service_areas_team_member_fk',
        'team_members.team_members_membership_fk',
        'working_hour_breaks.working_hour_breaks_working_hours_fk',
        'working_hours.working_hours_location_fk',
        'working_hours.working_hours_team_member_fk',
      ]),
    );
    for (const fk of compositeForeignKeys) {
      const index = fk.columns.indexOf('tenant_id');
      expect(fk.refColumns[index], fk.name).toBe('tenant_id');
    }
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
          sql`insert into rebook.tenants (id, name, slug, business_type, time_zone) values (${pair.b.id}, 'Imposter', ${`imposter-${pair.a.slug}`}, 'other_timed', 'Europe/London')`,
        ),
      ),
      PERMISSION_DENIED,
    );
  });

  it('updates zero rows of tenant B and its own row only (Phase 2: owners edit settings)', async () => {
    const other = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute(
        sql`update rebook.tenants set name = 'touched' where id = ${pair.b.id} returning 1`,
      ),
    );
    expect(other).toHaveLength(0);
    const own = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ name: string }>(
        sql`update rebook.tenants set name = ${pair.a.name} where id = ${pair.a.id} returning name`,
      ),
    );
    expect(own).toEqual([{ name: pair.a.name }]);
  });

  it('refuses to change the slug (links depend on it) and denies delete to the runtime role', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`update rebook.tenants set slug = ${`${pair.a.slug}-moved`} where id = ${pair.a.id}`,
        ),
      ),
      CHECK_VIOLATION,
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
