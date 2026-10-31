# ADR-002: Application schema, database roles and request context

- **Status:** Accepted (Phase 1 merged 30 Oct 2026). Extended by ADR-003 (time zones) and ADR-004 (identity, user context, authorised tenant context) in Phase 2.
- **Date:** 2026-10-29
- **Deciders:** Moses Oluwole (owner); drafted by Claude Code during Phase 1.
- **Source design:** `docs/architecture.md` §4 (tenancy, identity, authorisation) and §5 (data
  model and invariants); `docs/phases.md`, Phase 1.

## Context

Tenant isolation is the invariant that cannot be retrofitted. The design puts it in the
database: every statement runs inside a transaction that has set its tenant and actor, under a
role that cannot bypass row level security. Phase 1 turns that into concrete objects and makes
the choices the design left open: where the tables live, which roles exist and how they are
entered, how the request context reaches the policies, and how new tables are kept honest.

## Decisions

### 1. A dedicated `rebook` schema that the Data API never sees

All application tables live in `rebook`, not `public`. The schema is absent from
`[api].schemas` in `supabase/config.toml`, `auto_expose_new_tables` is off, the Data API roles (`anon`, `authenticated` and the
RLS-bypassing `service_role`) hold no privilege on the schema or any table, and
`pnpm db:check-schema` fails CI if that ever changes. PostgREST is therefore never a second read path around `withTenant`.
The hosted Supabase project must carry the same configuration before Phase 9.

### 2. Four roles; migrations run as Supabase's `postgres`

| Role                   | Login | Inherit | Bypass RLS | Privileges                                                         | Used by                                                 |
| ---------------------- | ----- | ------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `postgres`             | yes   | yes     | yes        | owner of everything (Supabase's role, the design's `rebook_owner`) | migrations, Drizzle Kit, `pnpm db:roles`, test fixtures |
| `rebook_authenticator` | yes   | **no**  | no         | none; member of `rebook_app` and `rebook_worker`                   | the app, the worker, the tests (`APP_DATABASE_URL`)     |
| `rebook_app`           | no    | yes     | no         | table privileges per table (see docs/schema.md)                    | `withTenant`                                            |
| `rebook_worker`        | no    | yes     | no         | identical to `rebook_app` in Phase 1; narrowed in Phase 6          | `withWorkerTenant`                                      |
| `rebook_platform`      | no    | yes     | no         | none                                                               | reserved for support access grants                      |

The login role is NOINHERIT, so a connection that has not run `SET LOCAL ROLE` can do nothing
to tenant data: forgetting `withTenant` fails with permission denied rather than reading as the
owner. Roles are cluster-wide and survive `supabase db reset`, so the migration guards each
`CREATE ROLE` and re-runs cleanly. No password appears in any migration: `pnpm db:roles` sets the
local one from `APP_DATABASE_URL`; production uses the platform secret store.

Alternatives rejected: a separate `rebook_owner` role (Supabase migrations already run as
`postgres`, and a second owner would need its own grant chain); one login role per runtime role
(two connection strings and two pools for no isolation gain, since both are NOBYPASSRLS).

### 3. Request context through `withTenant`

`withTenant(ctx, work)` validates `ctx` with Zod (`tenantId` UUID, `actorKind`, `actorId` UUID
or null, `requestId`), opens one transaction, runs `SET LOCAL ROLE rebook_app`, installs the four
`app.*` settings with `set_config(name, value, true)` using bind parameters (`SET LOCAL` cannot
take them), and passes a branded `TenantTx` to `work`. The brand is a non-exported `unique
symbol`, so a repository that requires `TenantTx` cannot be called with a bare database handle;
`tests/unit/tenancy/tenant-tx-type.test.ts` keeps that a compile error. `withWorkerTenant` is the
same with `rebook_worker`.

`withTenant` calls do not nest: a call inside another's work throws
`NestedTenantTransactionError` rather than silently opening a second transaction on another
pooled connection; the outer `TenantTx` is passed down instead.

Policies compare against `(select nullif(current_setting('app.tenant_id', true), '')::uuid)`.
On a pooled connection a setting that was once set reads back as an empty string in later
transactions; without `nullif` the `::uuid` cast would raise, with it the comparison is against
NULL and every policy fails closed to zero rows. `tests/integration/tenancy/with-tenant.test.ts`
proves both the empty-string reading and the zero-row result on a single-connection pool.

**Verified behind Supabase's transaction pooler (31 Oct 2026, Moses, hosted project).**
`rebook_authenticator.<project-ref>` authenticates through the transaction pooler (Supavisor
routes on the `.<project-ref>` suffix and Postgres sees the bare role), `SET LOCAL ROLE` into the
runtime roles works inside a pooled transaction, and the isolation, `withTenant` and user-context
suites pass there. The one failure was the Phase 1 "brand-new connection" probe, which assumed a
fresh backend and asserted that the raw setting is NULL; behind a pooler the backend has usually
served an earlier client, so it reads `''`. That is the case `nullif` exists for, and the policies
were never wrong. In Phase 3 the probe became "a transaction with no context installed": it
asserts `nullif(current_setting('app.tenant_id', true), '') is null` and zero rows in every
tenant-scoped table, on one pooled connection both before and after a tenant transaction, so the
same test holds locally and behind the pooler. `pnpm db:roles` accepts either username form and
compares only the role part (`scripts/lib/authenticator-role.ts`).

### 4. Tables and conventions

Core tables: `tenants`, `tenant_memberships`, `locations`, `audit_logs`, `tenant_feature_flags`,
`idempotency_keys`. UUIDv7 primary keys from `rebook.uuid_generate_v7()` (Postgres 17 has no
built-in; the function encodes the millisecond fraction in the 12 `rand_a` bits so ids created
in the same millisecond still sort in creation order, RFC 9562 §6.2 method 3). `timestamptz`
everywhere. Every tenant-owned table with an `id` has `unique (tenant_id, id)` so children can
reference it as `(tenant_id, parent_id) → parent (tenant_id, id)`; `tenant_feature_flags` is
keyed by `(tenant_id, flag)` instead, because a flag has no identity beyond its name.
Time zones are checked by `rebook.is_time_zone()`: an Area/Location name or `UTC` known to
`pg_timezone_names` (abbreviations such as `EST` are rejected); the app canonicalises input with
Intl before the database sees it (ADR-003). Indexes cover the two Phase 1 query paths beyond primary keys:
`audit_logs (tenant_id, created_at desc)` and `tenant_memberships (user_id)`.

Phase 1 has no table with a composite child key yet (the first arrive with services and team
members in Phase 3). The pattern is proven on a probe child table created and dropped by
`tests/integration/tenancy/composite-foreign-keys.app-role.test.ts`, exercised through
`withTenant` as both runtime roles, and the generated isolation suite discovers real composite
keys from the catalogue, so Phase 3 gets its cross-tenant insert tests for free.

### 5. Policies and grants

RLS is enabled and forced on every table. `tenants`: select and insert only where `id` is the
current tenant (the app generates the id, opens the context with it, then inserts); no update or
delete policy or privilege yet. `tenant_memberships`: a tenant manages its rows, and a user also
sees rows where `user_id` is the current actor, so Phase 2 can list a signed-in user's tenants.
Every other table: one policy for all commands on `tenant_id`. `audit_logs`: INSERT and SELECT
only for runtime roles, so it is append-only. Feature flags are toggled only through
`toggleFeatureFlag` (owner-only since Phase 2), which writes the audit entry (before and after)
in the same transaction; the raw repository is not exported. All of this is hand-written SQL in
`supabase/migrations`; Drizzle Kit generates only the table DDL (see ADR-001 for the single
applier).

### 6. Two connection strings

`APP_DATABASE_URL` (required at boot) connects the app as `rebook_authenticator`. `DATABASE_URL`
(optional for the app) is the owner connection for migrations, Drizzle Kit, `pnpm db:roles` and
owner-only test fixtures; production leaves it unset on the web and worker. Test helpers expose
them as `connectAppDb()` and `connectOwnerDb()`, and fixtures that seed two tenants live in one
clearly labelled owner-only file.

### 7. Keeping new tables honest

- `pnpm db:check-schema` (CI): every `rebook` table has `tenant_id` (allow-list: `tenants`),
  RLS enabled and forced, at least one policy, no privilege for `anon`, `authenticated` or
  `service_role` (the schema itself grants them nothing), and every foreign key is either
  `tenant_id → tenants(id)` or a composite key starting with `tenant_id`.
- `tests/integration/tenancy/isolation.generated.test.ts`: generated from the catalogue; a new
  tenant-owned table fails the suite until it has a touch expression and a sample row.
- `pnpm db:docs --check` (CI): `docs/schema.md` is regenerated from the catalogue and must be
  committed with the migration that changes it.

## Consequences

- Positive: a forgotten `withTenant` is a hard failure, not a silent owner read; policies fail
  closed on pooled connections; the Data API cannot reach tenant data; every later table inherits
  the checks and the generated tests.
- Costs: every query runs inside a transaction (negligible at MVP load, as the design notes);
  two connection strings to manage; `pnpm db:roles` is an extra local step after a fresh
  `supabase start` or `db reset` (wired into `pnpm db:start` and `pnpm db:reset`).
- Resolved in Phase 2 (new migrations, ADR-004): `tenant_memberships.user_id` references
  `auth.users(id) on delete cascade`, and the memberships select policy's actor branch applies to
  `actor_kind = 'user'` only. The schema check accepts a single-column key to `auth.users(id)`
  as the one non-tenant parent.
- Revisit when: Phase 6 narrows `rebook_worker`; support access grants give `rebook_platform`
  its policies; Postgres 18's built-in `uuidv7()` becomes available on Supabase.
