import { type Sql, type TransactionSql } from 'postgres';

/**
 * The tenant-isolation invariants every table in the `rebook` schema must satisfy
 * (docs/phases.md Phase 1, docs/adr/ADR-002-schema-roles-context.md). Used by
 * `pnpm db:check-schema` in CI and by tests/integration/tenancy/schema-check.test.ts.
 */

/**
 * Tables that legitimately have no tenant_id column. `tenants` is the tenant; `rate_limits` is
 * platform-level (sign-in happens before any tenant exists) and holds only hashed keys and
 * counters (docs/adr/ADR-004-auth-sessions.md §9).
 */
export const TENANT_ID_ALLOW_LIST: readonly string[] = ['tenants', 'rate_limits'];

/**
 * Roles that must never hold a privilege on a `rebook` table or on the schema: the Supabase Data
 * API roles. `service_role` bypasses RLS, so a grant to it would be a full cross-tenant read path.
 */
export const FORBIDDEN_GRANTEES: readonly string[] = ['anon', 'authenticated', 'service_role'];

export interface SchemaFinding {
  readonly table: string;
  readonly problem: string;
}

export type SqlHandle = Sql | TransactionSql;

interface TableRow {
  readonly table: string;
  readonly has_tenant_id: boolean;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly policy_count: number;
}

interface GrantRow {
  readonly table: string;
  readonly grantee: string;
  readonly privileges: string[];
}

interface ForeignKeyRow {
  readonly table: string;
  readonly name: string;
  readonly ref_schema: string;
  readonly ref_table: string;
  readonly ref_has_tenant_id: boolean;
  readonly columns: string[];
  readonly ref_columns: string[];
}

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

export async function checkSchema(sql: SqlHandle): Promise<SchemaFinding[]> {
  const findings: SchemaFinding[] = [];

  for (const grantee of FORBIDDEN_GRANTEES) {
    const [row] = await sql<{ usage: boolean; create: boolean }[]>`
      select has_schema_privilege(${grantee}, 'rebook', 'USAGE') as usage,
             has_schema_privilege(${grantee}, 'rebook', 'CREATE') as create
    `;
    if (row?.usage === true || row?.create === true) {
      findings.push({
        table: '(schema rebook)',
        problem: `${grantee} has a privilege on the schema`,
      });
    }
  }

  const tables = await sql<TableRow[]>`
    select
      c.relname as table,
      exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
      ) as has_tenant_id,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced,
      (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid)::int as policy_count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'rebook' and c.relkind in ('r', 'p')
    order by c.relname
  `;

  const grants = await sql<GrantRow[]>`
    select c.relname as table, g.grantee,
      array(
        select priv from unnest(${TABLE_PRIVILEGES}::text[]) as priv
        where has_table_privilege(g.grantee, c.oid, priv)
      ) as privileges
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(${[...FORBIDDEN_GRANTEES]}::text[]) as g(grantee)
    where n.nspname = 'rebook' and c.relkind in ('r', 'p')
    order by c.relname, g.grantee
  `;

  // Every foreign key out of a rebook table is one of three shapes, so a row can never point into
  // another tenant (docs/architecture.md §5, ADR-002 §7, extended in Phase 3):
  //   - tenant_id → rebook.tenants(id);
  //   - a composite key into a tenant-owned rebook table that maps the child's tenant_id to the
  //     parent's tenant_id: (tenant_id, parent_id) → parent (tenant_id, id). A key into a
  //     tenant-owned parent without that pair (parent_id alone, or tenant_id matched against some
  //     other parent column) fails;
  //   - a single user column → auth.users(id): Supabase Auth users are not tenant-owned.
  // A key into a rebook table that has no tenant_id (other than tenants) fails as well.
  const foreignKeys = await sql<ForeignKeyRow[]>`
    select c.relname as table, k.conname as name, rn.nspname as ref_schema, r.relname as ref_table,
      exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = r.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
      ) as ref_has_tenant_id,
      array(
        select a.attname from unnest(k.conkey) with ordinality as u(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
        order by u.ord
      ) as columns,
      array(
        select a.attname from unnest(k.confkey) with ordinality as u(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum
        order by u.ord
      ) as ref_columns
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_class r on r.oid = k.confrelid
    join pg_catalog.pg_namespace rn on rn.oid = r.relnamespace
    where n.nspname = 'rebook' and k.contype = 'f'
    order by c.relname, k.conname
  `;

  for (const table of tables) {
    if (!table.has_tenant_id && !TENANT_ID_ALLOW_LIST.includes(table.table)) {
      findings.push({ table: table.table, problem: 'has no tenant_id column' });
    }
    if (!table.rls_enabled) {
      findings.push({ table: table.table, problem: 'row level security is not enabled' });
    }
    if (!table.rls_forced) {
      findings.push({ table: table.table, problem: 'row level security is not forced' });
    }
    if (table.policy_count === 0) {
      findings.push({ table: table.table, problem: 'has no row level security policy' });
    }
  }

  for (const fk of foreignKeys) {
    const single = fk.columns.length === 1;
    const inRebook = fk.ref_schema === 'rebook';
    const toTenants =
      single &&
      fk.columns[0] === 'tenant_id' &&
      inRebook &&
      fk.ref_table === 'tenants' &&
      fk.ref_columns[0] === 'id';
    const toAuthUser =
      single && fk.ref_schema === 'auth' && fk.ref_table === 'users' && fk.ref_columns[0] === 'id';
    const pairsTenant = fk.columns.some(
      (column, index) => column === 'tenant_id' && fk.ref_columns[index] === 'tenant_id',
    );
    const toTenantOwnedParent = !single && inRebook && fk.ref_has_tenant_id && pairsTenant;
    if (!toTenants && !toAuthUser && !toTenantOwnedParent) {
      const why =
        inRebook && fk.ref_has_tenant_id
          ? `; a key into tenant-owned rebook.${fk.ref_table} must map tenant_id to its tenant_id (references ${fk.ref_columns.join(', ')})`
          : '';
      findings.push({
        table: fk.table,
        problem: `foreign key ${fk.name} to ${fk.ref_schema}.${fk.ref_table} (${fk.columns.join(', ')}) must be tenant_id → tenants(id), (tenant_id, …) → parent (tenant_id, id), or a user column → auth.users(id)${why}`,
      });
    }
  }

  for (const grant of grants) {
    if (grant.privileges.length > 0) {
      findings.push({
        table: grant.table,
        problem: `${grant.grantee} holds ${grant.privileges.join(', ')}`,
      });
    }
  }

  return findings;
}

export function formatFindings(findings: readonly SchemaFinding[]): string {
  return findings.map((finding) => `  - rebook.${finding.table}: ${finding.problem}`).join('\n');
}
