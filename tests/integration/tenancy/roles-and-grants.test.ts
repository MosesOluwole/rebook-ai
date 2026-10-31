import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { listRebookTables, type RebookTable } from '../../helpers/catalogue';
import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, PERMISSION_DENIED } from '../../helpers/sql-state';
import { contextFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/**
 * Role and privilege rules (docs/phases.md Phase 1, extended in Phase 2): the login role holds
 * nothing, the Data API roles hold nothing, runtime roles cannot bypass RLS, audit_logs is
 * append-only, and the slug resolver is callable by rebook_app alone.
 */

const catalogueOwner = await connectOwnerDb({ max: 1 });
const tables: RebookTable[] = await listRebookTables(catalogueOwner);
await catalogueOwner.close();

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'roles');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('role attributes', () => {
  it('match the design: one NOINHERIT login role, NOBYPASSRLS runtime roles, a reserved platform role', async () => {
    const roles = await owner.sql<
      {
        rolname: string;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }[]
    >`
      select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper
      from pg_catalog.pg_roles where rolname like 'rebook\\_%' order by rolname
    `;
    expect(roles).toEqual([
      {
        rolname: 'rebook_app',
        rolcanlogin: false,
        rolinherit: true,
        rolbypassrls: false,
        rolsuper: false,
      },
      {
        rolname: 'rebook_authenticator',
        rolcanlogin: true,
        rolinherit: false,
        rolbypassrls: false,
        rolsuper: false,
      },
      {
        rolname: 'rebook_platform',
        rolcanlogin: false,
        rolinherit: true,
        rolbypassrls: false,
        rolsuper: false,
      },
      {
        rolname: 'rebook_worker',
        rolcanlogin: false,
        rolinherit: true,
        rolbypassrls: false,
        rolsuper: false,
      },
    ]);
  });

  it('let rebook_authenticator switch to exactly the two runtime roles', async () => {
    const memberships = await owner.sql<{ role: string }[]>`
      select g.rolname as role
      from pg_catalog.pg_auth_members m
      join pg_catalog.pg_roles g on g.oid = m.roleid
      join pg_catalog.pg_roles u on u.oid = m.member
      where u.rolname = 'rebook_authenticator' order by 1
    `;
    expect(memberships.map((row) => row.role)).toEqual(['rebook_app', 'rebook_worker']);
  });

  it('leave rebook_platform and rebook_authenticator without any table privilege', async () => {
    for (const role of ['rebook_platform', 'rebook_authenticator']) {
      const [row] = await owner.sql<{ any_privilege: boolean }[]>`
        select bool_or(
          has_table_privilege(${role}, c.oid, 'SELECT') or has_table_privilege(${role}, c.oid, 'INSERT') or
          has_table_privilege(${role}, c.oid, 'UPDATE') or has_table_privilege(${role}, c.oid, 'DELETE')
        ) as any_privilege
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'rebook' and c.relkind = 'r'
      `;
      expect(row?.any_privilege, role).toBe(false);
    }
  });
});

describe('rebook_authenticator outside withTenant', () => {
  it.each(tables)('gets permission denied reading rebook.$table', async ({ table }) => {
    await expectSqlState(
      app.client.sql`select 1 from rebook.${app.client.sql(table)} limit 1`,
      PERMISSION_DENIED,
    );
  });

  it.each(tables)('gets permission denied writing rebook.$table', async ({ table }) => {
    await expectSqlState(
      app.client.sql`delete from rebook.${app.client.sql(table)} where false`,
      PERMISSION_DENIED,
    );
  });

  it('cannot call the UUIDv7 function either', async () => {
    await expectSqlState(app.client.sql`select rebook.uuid_generate_v7()`, PERMISSION_DENIED);
  });

  it('cannot call the slug resolver outside a user context', async () => {
    await expectSqlState(
      app.client.sql`select rebook.resolve_tenant_slug(${pair.a.slug})`,
      PERMISSION_DENIED,
    );
  });
});

describe('rebook.rate_limit_hit (Phase 2 follow-ups)', () => {
  it('is executable by rebook_app only and unreachable for the login role outside a context', async () => {
    const [grants] = await owner.sql<Record<string, boolean>[]>`
      select
        has_function_privilege('rebook_app', 'rebook.rate_limit_hit(text, integer, integer, timestamptz)', 'EXECUTE') as app,
        has_function_privilege('rebook_worker', 'rebook.rate_limit_hit(text, integer, integer, timestamptz)', 'EXECUTE') as worker,
        has_function_privilege('rebook_authenticator', 'rebook.rate_limit_hit(text, integer, integer, timestamptz)', 'EXECUTE') as authenticator,
        has_function_privilege('anon', 'rebook.rate_limit_hit(text, integer, integer, timestamptz)', 'EXECUTE') as anon,
        has_function_privilege('authenticated', 'rebook.rate_limit_hit(text, integer, integer, timestamptz)', 'EXECUTE') as authenticated
    `;
    expect(grants).toEqual({
      app: true,
      worker: false,
      authenticator: false,
      anon: false,
      authenticated: false,
    });
    await expectSqlState(
      app.client.sql`select rebook.rate_limit_hit(${'a'.repeat(64)}, 60, 1, now())`,
      PERMISSION_DENIED,
    );
  });
});

describe('rebook.resolve_tenant_slug (Phase 2)', () => {
  it('is SECURITY DEFINER with an empty search_path, executable by rebook_app only', async () => {
    const [fn] = await owner.sql<{ secdef: boolean; config: string[] | null }[]>`
      select p.prosecdef as secdef, p.proconfig as config
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'rebook' and p.proname = 'resolve_tenant_slug'
    `;
    expect(fn?.secdef).toBe(true);
    expect(fn?.config).toEqual(['search_path=""']);

    const [grants] = await owner.sql<Record<string, boolean>[]>`
      select
        has_function_privilege('rebook_app', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as app,
        has_function_privilege('rebook_worker', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as worker,
        has_function_privilege('rebook_authenticator', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as authenticator,
        has_function_privilege('rebook_platform', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as platform,
        has_function_privilege('anon', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as anon,
        has_function_privilege('authenticated', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as authenticated,
        has_function_privilege('service_role', 'rebook.resolve_tenant_slug(text)', 'EXECUTE') as data_api_admin
    `;
    expect(grants).toEqual({
      app: true,
      worker: false,
      authenticator: false,
      platform: false,
      anon: false,
      authenticated: false,
      data_api_admin: false,
    });
  });

  it('returns the id for a known slug and null otherwise, from a context with no tenant', async () => {
    const [row] = await app.client.sql.begin(async (tx) => {
      await tx`set local role rebook_app`;
      return tx<{ known: string | null; unknown: string | null }[]>`
        select rebook.resolve_tenant_slug(${pair.a.slug}) as known,
               rebook.resolve_tenant_slug(${`${pair.a.slug}-nope`}) as unknown
      `;
    });
    expect(row).toEqual({ known: pair.a.id, unknown: null });
  });
});

describe('Supabase Data API roles (anon, authenticated)', () => {
  it.each(['anon', 'authenticated'])(
    '%s has no privilege on the schema or any table',
    async (role) => {
      const [schema] = await owner.sql<{ usage: boolean }[]>`
      select has_schema_privilege(${role}, 'rebook', 'USAGE') as usage
    `;
      expect(schema?.usage).toBe(false);
      for (const { table } of tables) {
        const [row] = await owner.sql<{ any_privilege: boolean }[]>`
        select has_table_privilege(${role}, ${`rebook.${table}`}, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as any_privilege
      `;
        expect(row?.any_privilege, `${role} on ${table}`).toBe(false);
      }
    },
  );

  it.each(['anon', 'authenticated'])('%s is denied when it actually tries', async (role) => {
    for (const { table } of tables) {
      await expectSqlState(
        owner.sql.begin(async (tx) => {
          await tx`set local role ${tx(role)}`;
          return tx`select 1 from rebook.${tx(table)} limit 1`;
        }),
        PERMISSION_DENIED,
      );
    }
  });
});

describe('audit_logs is append-only for runtime roles', () => {
  it('allows insert and select', async () => {
    const rows = await app.tenancy.withTenant(contextFor(pair.a.id), async (tx) => {
      await tx.db.execute(sql`
        insert into rebook.audit_logs (tenant_id, actor_kind, action, entity_type)
        values (${pair.a.id}, 'system', 'probe.append', 'probe')
      `);
      return tx.db.execute<{ action: string }>(
        sql`select action from rebook.audit_logs where tenant_id = ${pair.a.id} order by created_at`,
      );
    });
    expect(rows.map((row) => row.action)).toContain('probe.append');
  });

  it.each(['rebook_app', 'rebook_worker'] as const)(
    'denies UPDATE and DELETE to %s',
    async (role) => {
      const run = role === 'rebook_app' ? app.tenancy.withTenant : app.tenancy.withWorkerTenant;
      await expectSqlState(
        run(contextFor(pair.a.id, { actorKind: 'worker', actorId: null }), (tx) =>
          tx.db.execute(
            sql`update rebook.audit_logs set action = 'tampered.row' where tenant_id = ${pair.a.id}`,
          ),
        ),
        PERMISSION_DENIED,
      );
      await expectSqlState(
        run(contextFor(pair.a.id, { actorKind: 'worker', actorId: null }), (tx) =>
          tx.db.execute(sql`delete from rebook.audit_logs where tenant_id = ${pair.a.id}`),
        ),
        PERMISSION_DENIED,
      );
    },
  );
});
