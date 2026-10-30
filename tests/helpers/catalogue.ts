import { type DbClient } from '@/shared/db/client';

/** What the catalogue says about the `rebook` schema. Read as the owner; never cached across files. */

export interface RebookTable {
  readonly table: string;
  readonly hasTenantId: boolean;
  readonly hasId: boolean;
  readonly appPrivileges: readonly string[];
}

export interface CompositeForeignKey {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

/** `appPrivileges` are those of `role` (default rebook_app); pass 'rebook_worker' for the worker. */
export async function listRebookTables(
  owner: DbClient,
  role: 'rebook_app' | 'rebook_worker' = 'rebook_app',
): Promise<RebookTable[]> {
  const rows = await owner.sql<
    { table: string; has_tenant_id: boolean; has_id: boolean; app_privileges: string[] }[]
  >`
    select
      c.relname as table,
      exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
      ) as has_tenant_id,
      exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
      ) as has_id,
      array(
        select priv from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as priv
        where has_table_privilege(${role}, c.oid, priv)
      ) as app_privileges
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'rebook' and c.relkind in ('r', 'p')
    order by c.relname
  `;
  return rows.map((row) => ({
    table: row.table,
    hasTenantId: row.has_tenant_id,
    hasId: row.has_id,
    appPrivileges: row.app_privileges,
  }));
}

/** Foreign keys with more than one column, i.e. the (tenant_id, parent_id) pattern. */
export async function listCompositeForeignKeys(owner: DbClient): Promise<CompositeForeignKey[]> {
  const rows = await owner.sql<
    { table: string; name: string; columns: string[]; ref_table: string; ref_columns: string[] }[]
  >`
    select
      c.relname as table,
      k.conname as name,
      array(
        select a.attname from unnest(k.conkey) with ordinality as u(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
        order by u.ord
      ) as columns,
      r.relname as ref_table,
      array(
        select a.attname from unnest(k.confkey) with ordinality as u(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum
        order by u.ord
      ) as ref_columns
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_class r on r.oid = k.confrelid
    where n.nspname = 'rebook' and k.contype = 'f' and array_length(k.conkey, 1) > 1
    order by c.relname, k.conname
  `;
  return rows.map((row) => ({
    table: row.table,
    name: row.name,
    columns: row.columns,
    refTable: row.ref_table,
    refColumns: row.ref_columns,
  }));
}

export async function hasUniqueOn(
  owner: DbClient,
  table: string,
  columns: readonly string[],
): Promise<boolean> {
  const [row] = await owner.sql<{ found: boolean }[]>`
    select exists (
      select 1
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'rebook' and c.relname = ${table} and k.contype in ('u', 'p')
        and array(
          select a.attname from unnest(k.conkey) with ordinality as u(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
          order by u.ord
        )::text[] = ${[...columns]}::text[]
    ) as found
  `;
  return row?.found ?? false;
}
