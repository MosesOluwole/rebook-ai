import { type Sql } from 'postgres';

/**
 * Renders the generated half of docs/schema.md from the live catalogue: roles, functions, and
 * for every table in `rebook` its columns, constraints, indexes, RLS policies and grants.
 * Deterministic ordering so `pnpm db:docs --check` can diff it.
 */

export const GENERATED_START = '<!-- generated:start (pnpm db:docs) -->';
export const GENERATED_END = '<!-- generated:end -->';

interface ColumnRow {
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default_value: string | null;
}

interface ConstraintRow {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

interface IndexRow {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

interface PolicyRow {
  readonly table: string;
  readonly name: string;
  readonly command: string;
  readonly roles: string[];
  readonly using_expression: string | null;
  readonly check_expression: string | null;
}

interface TableRow {
  readonly table: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly comment: string | null;
}

interface GrantRow {
  readonly table: string;
  readonly role: string;
  readonly privileges: string[];
}

interface RoleRow {
  readonly role: string;
  readonly can_login: boolean;
  readonly inherit: boolean;
  readonly bypass_rls: boolean;
  readonly member_of: string[];
  readonly comment: string | null;
}

interface FunctionRow {
  readonly signature: string;
  readonly returns: string;
  readonly volatility: string;
  readonly comment: string | null;
}

const RUNTIME_ROLES = ['rebook_app', 'rebook_worker'];
const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

function code(value: string | null): string {
  return value === null ? '' : `\`${value.replace(/\|/g, '\\|')}\``;
}

export async function renderSchemaDoc(sql: Sql): Promise<string> {
  const roles = await sql<RoleRow[]>`
    select r.rolname as role, r.rolcanlogin as can_login, r.rolinherit as inherit,
           r.rolbypassrls as bypass_rls,
           array(select g.rolname from pg_catalog.pg_auth_members m
                 join pg_catalog.pg_roles g on g.oid = m.roleid
                 where m.member = r.oid order by g.rolname) as member_of,
           pg_catalog.shobj_description(r.oid, 'pg_authid') as comment
    from pg_catalog.pg_roles r
    where r.rolname like 'rebook\\_%'
    order by r.rolname
  `;
  const functions = await sql<FunctionRow[]>`
    select p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as signature,
           pg_catalog.pg_get_function_result(p.oid) as returns,
           case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end as volatility,
           pg_catalog.obj_description(p.oid, 'pg_proc') as comment
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'rebook'
    order by p.proname
  `;
  const tables = await sql<TableRow[]>`
    select c.relname as table, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
           pg_catalog.obj_description(c.oid, 'pg_class') as comment
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'rebook' and c.relkind in ('r', 'p')
    order by c.relname
  `;
  const columns = await sql<ColumnRow[]>`
    select c.relname as table, a.attname as column,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
           not a.attnotnull as nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_value
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'rebook' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `;
  const constraints = await sql<ConstraintRow[]>`
    select c.relname as table, k.conname as name, pg_catalog.pg_get_constraintdef(k.oid, true) as definition
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'rebook'
    order by c.relname, k.contype, k.conname
  `;
  const indexes = await sql<IndexRow[]>`
    select tablename as table, indexname as name, indexdef as definition
    from pg_catalog.pg_indexes
    where schemaname = 'rebook'
    order by tablename, indexname
  `;
  const policies = await sql<PolicyRow[]>`
    select tablename as table, policyname as name, cmd as command, roles::text[] as roles,
           qual as using_expression, with_check as check_expression
    from pg_catalog.pg_policies
    where schemaname = 'rebook'
    order by tablename, policyname
  `;
  const grants = await sql<GrantRow[]>`
    select c.relname as table, r.role,
           array(select priv from unnest(${TABLE_PRIVILEGES}::text[]) as priv
                 where has_table_privilege(r.role, c.oid, priv)) as privileges
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(${RUNTIME_ROLES}::text[]) as r(role)
    where n.nspname = 'rebook' and c.relkind in ('r', 'p')
    order by c.relname, r.role
  `;

  const lines: string[] = [GENERATED_START, ''];

  lines.push(
    '### Roles',
    '',
    '| Role | Login | Inherit | Bypass RLS | Member of | Purpose |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const role of roles) {
    lines.push(
      `| \`${role.role}\` | ${role.can_login ? 'yes' : 'no'} | ${role.inherit ? 'yes' : 'no'} | ${role.bypass_rls ? 'yes' : 'no'} | ${role.member_of.map((m) => `\`${m}\``).join(', ') || '—'} | ${role.comment ?? ''} |`,
    );
  }

  lines.push(
    '',
    '### Functions',
    '',
    '| Function | Returns | Volatility | Purpose |',
    '| --- | --- | --- | --- |',
  );
  for (const fn of functions) {
    lines.push(
      `| \`rebook.${fn.signature}\` | \`${fn.returns}\` | ${fn.volatility} | ${fn.comment ?? ''} |`,
    );
  }

  for (const table of tables) {
    lines.push('', `### \`rebook.${table.table}\``, '');
    if (table.comment !== null) {
      lines.push(table.comment, '');
    }
    lines.push(
      `Row level security: ${table.rls_enabled ? 'enabled' : 'DISABLED'}, ${table.rls_forced ? 'forced' : 'NOT forced'}.`,
      '',
      '| Column | Type | Nullable | Default |',
      '| --- | --- | --- | --- |',
    );
    for (const column of columns.filter((c) => c.table === table.table)) {
      lines.push(
        `| \`${column.column}\` | \`${column.type}\` | ${column.nullable ? 'yes' : 'no'} | ${code(column.default_value)} |`,
      );
    }
    lines.push('', '| Constraint | Definition |', '| --- | --- |');
    for (const constraint of constraints.filter((c) => c.table === table.table)) {
      lines.push(`| \`${constraint.name}\` | ${code(constraint.definition)} |`);
    }
    const tableIndexes = indexes.filter((i) => i.table === table.table);
    if (tableIndexes.length > 0) {
      lines.push('', '| Index | Definition |', '| --- | --- |');
      for (const index of tableIndexes) {
        lines.push(`| \`${index.name}\` | ${code(index.definition)} |`);
      }
    }
    lines.push(
      '',
      '| Policy | Command | Roles | Using | With check |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const policy of policies.filter((p) => p.table === table.table)) {
      lines.push(
        `| \`${policy.name}\` | ${policy.command} | ${policy.roles.map((r) => `\`${r}\``).join(', ')} | ${code(policy.using_expression)} | ${code(policy.check_expression)} |`,
      );
    }
    lines.push('', '| Role | Privileges |', '| --- | --- |');
    for (const grant of grants.filter((g) => g.table === table.table)) {
      lines.push(`| \`${grant.role}\` | ${grant.privileges.join(', ') || 'none'} |`);
    }
  }

  lines.push('', GENERATED_END);
  return lines.join('\n');
}

/** Replaces the generated block inside an existing document, or appends it when absent. */
export function spliceGenerated(document: string, generated: string): string {
  const start = document.indexOf(GENERATED_START);
  const end = document.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) {
    return `${document.trimEnd()}\n\n${generated}\n`;
  }
  return `${document.slice(0, start)}${generated}${document.slice(end + GENERATED_END.length)}`;
}
