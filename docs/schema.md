# Database schema

The `rebook` schema as it exists after the migrations in `supabase/migrations`. The invariants
section is written by hand; the catalogue section is generated from the local database by
`pnpm db:docs` and checked in CI with `pnpm db:docs --check`, so it always matches the migrations
that were committed with it. Decisions behind the shape are in
[ADR-002](./adr/ADR-002-schema-roles-context.md); the design is `docs/architecture.md` §4 and §5.

## Invariants

| Invariant                       | Enforcement                                                                                                                                             | Test                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No cross-tenant reads or writes | RLS enabled and forced on every table; policies on `app.tenant_id`; runtime roles are NOBYPASSRLS                                                       | `tests/integration/tenancy/isolation.generated.test.ts`                                               |
| Context fails closed            | `nullif(current_setting('app.tenant_id', true), '')::uuid` → NULL matches nothing                                                                       | `with-tenant.test.ts` (pooled connection), isolation suite                                            |
| No access outside `withTenant`  | `rebook_authenticator` is NOINHERIT with no table privileges                                                                                            | `roles-and-grants.test.ts`                                                                            |
| No Data API path                | `rebook` absent from `[api].schemas`; no grants to `anon`, `authenticated` or `service_role`; CI schema check                                           | `data-api-config.test.ts`, `roles-and-grants.test.ts`, `schema-check.test.ts`                         |
| No cross-tenant references      | `unique (tenant_id, id)` on every tenant-owned table with an id; children use composite foreign keys; the CI schema check rejects any other foreign key | `composite-foreign-keys.app-role.test.ts`, `schema-check.test.ts`, isolation suite (catalogue-driven) |
| Audit log is append-only        | runtime roles hold INSERT and SELECT only                                                                                                               | `roles-and-grants.test.ts`                                                                            |
| Ids are time-ordered            | `rebook.uuid_generate_v7()` default; sub-millisecond ordering                                                                                           | `uuid-v7.test.ts`                                                                                     |
| Time zones are real             | `rebook.is_time_zone()` CHECK on `tenants` and `locations`                                                                                              | `tenant.test.ts` (app side), CHECK constraint                                                         |
| Every new table is covered      | `pnpm db:check-schema`; generated suite requires a fixture entry                                                                                        | `schema-check.test.ts`                                                                                |

## Request context

| Setting          | Set by `withTenant` from | Read by                            |
| ---------------- | ------------------------ | ---------------------------------- |
| `app.tenant_id`  | `ctx.tenantId` (UUID)    | every policy                       |
| `app.actor_id`   | `ctx.actorId` or `''`    | `tenant_memberships` select policy |
| `app.actor_kind` | `ctx.actorKind`          | audit entries (via the repository) |
| `app.request_id` | `ctx.requestId`          | audit entries (via the repository) |

## Catalogue

<!-- generated:start (pnpm db:docs) -->

### Roles

| Role                   | Login | Inherit | Bypass RLS | Member of                     | Purpose                                                                                                                                      |
| ---------------------- | ----- | ------- | ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebook_app`           | no    | yes     | no         | —                             | Rebook AI web request role. NOBYPASSRLS; entered with SET LOCAL ROLE inside withTenant.                                                      |
| `rebook_authenticator` | yes   | no      | no         | `rebook_app`, `rebook_worker` | Rebook AI login role for the app, worker and tests. No table privileges; withTenant switches to rebook_app or rebook_worker per transaction. |
| `rebook_platform`      | no    | yes     | no         | —                             | Rebook AI platform support role. Reserved; no grants until support access grants exist.                                                      |
| `rebook_worker`        | no    | yes     | no         | —                             | Rebook AI background job role. NOBYPASSRLS; entered with SET LOCAL ROLE inside withWorkerTenant.                                             |

### Functions

| Function                         | Returns   | Volatility | Purpose                                                                                          |
| -------------------------------- | --------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `rebook.is_time_zone(zone text)` | `boolean` | immutable  | True when the argument is an IANA time zone name known to Postgres (Area/Location form, or UTC). |
| `rebook.uuid_generate_v7()`      | `uuid`    | volatile   | UUIDv7 with sub-millisecond ordering (RFC 9562 §6.2 method 3). Default for every primary key.    |

### `rebook.audit_logs`

Row level security: enabled, forced.

| Column        | Type                       | Nullable | Default                     |
| ------------- | -------------------------- | -------- | --------------------------- |
| `id`          | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`   | `uuid`                     | no       |                             |
| `actor_kind`  | `text`                     | no       |                             |
| `actor_id`    | `uuid`                     | yes      |                             |
| `request_id`  | `text`                     | yes      |                             |
| `action`      | `text`                     | no       |                             |
| `entity_type` | `text`                     | no       |                             |
| `entity_id`   | `uuid`                     | yes      |                             |
| `before`      | `jsonb`                    | yes      |                             |
| `after`       | `jsonb`                    | yes      |                             |
| `created_at`  | `timestamp with time zone` | no       | `now()`                     |

| Constraint                           | Definition                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `audit_logs_action_format`           | `CHECK (action ~ '^[a-z_]+(?:\.[a-z_]+)+$'::text)`                                                                    |
| `audit_logs_actor_kind_valid`        | `CHECK (actor_kind = ANY (ARRAY['user'::text, 'customer'::text, 'anonymous'::text, 'worker'::text, 'system'::text]))` |
| `audit_logs_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                               |
| `audit_logs_pkey`                    | `PRIMARY KEY (id)`                                                                                                    |
| `audit_logs_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                                                                              |

| Index                                 | Definition                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs_pkey`                     | `CREATE UNIQUE INDEX audit_logs_pkey ON rebook.audit_logs USING btree (id)`                                                 |
| `audit_logs_tenant_id_created_at_idx` | `CREATE INDEX audit_logs_tenant_id_created_at_idx ON rebook.audit_logs USING btree (tenant_id, created_at DESC NULLS LAST)` |
| `audit_logs_tenant_id_id_unique`      | `CREATE UNIQUE INDEX audit_logs_tenant_id_id_unique ON rebook.audit_logs USING btree (tenant_id, id)`                       |

| Policy                        | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ----------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `audit_logs_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges     |
| --------------- | -------------- |
| `rebook_app`    | SELECT, INSERT |
| `rebook_worker` | SELECT, INSERT |

### `rebook.idempotency_keys`

Row level security: enabled, forced.

| Column            | Type                       | Nullable | Default                     |
| ----------------- | -------------------------- | -------- | --------------------------- |
| `id`              | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`       | `uuid`                     | no       |                             |
| `scope`           | `text`                     | no       |                             |
| `key`             | `text`                     | no       |                             |
| `request_hash`    | `text`                     | no       |                             |
| `response_status` | `integer`                  | yes      |                             |
| `response_body`   | `jsonb`                    | yes      |                             |
| `created_at`      | `timestamp with time zone` | no       | `now()`                     |
| `expires_at`      | `timestamp with time zone` | no       |                             |

| Constraint                                    | Definition                                              |
| --------------------------------------------- | ------------------------------------------------------- |
| `idempotency_keys_tenant_id_tenants_id_fk`    | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)` |
| `idempotency_keys_pkey`                       | `PRIMARY KEY (id)`                                      |
| `idempotency_keys_tenant_id_id_unique`        | `UNIQUE (tenant_id, id)`                                |
| `idempotency_keys_tenant_id_scope_key_unique` | `UNIQUE (tenant_id, scope, key)`                        |

| Index                                         | Definition                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `idempotency_keys_pkey`                       | `CREATE UNIQUE INDEX idempotency_keys_pkey ON rebook.idempotency_keys USING btree (id)`                                          |
| `idempotency_keys_tenant_id_id_unique`        | `CREATE UNIQUE INDEX idempotency_keys_tenant_id_id_unique ON rebook.idempotency_keys USING btree (tenant_id, id)`                |
| `idempotency_keys_tenant_id_scope_key_unique` | `CREATE UNIQUE INDEX idempotency_keys_tenant_id_scope_key_unique ON rebook.idempotency_keys USING btree (tenant_id, scope, key)` |

| Policy                              | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ----------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `idempotency_keys_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT, INSERT, UPDATE, DELETE |

### `rebook.locations`

Row level security: enabled, forced.

| Column       | Type                       | Nullable | Default                     |
| ------------ | -------------------------- | -------- | --------------------------- |
| `id`         | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`  | `uuid`                     | no       |                             |
| `name`       | `text`                     | no       |                             |
| `time_zone`  | `text`                     | no       |                             |
| `created_at` | `timestamp with time zone` | no       | `now()`                     |
| `updated_at` | `timestamp with time zone` | no       | `now()`                     |

| Constraint                          | Definition                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| `locations_name_length`             | `CHECK (length(btrim(name)) >= 1 AND length(btrim(name)) <= 120)` |
| `locations_time_zone_valid`         | `CHECK (rebook.is_time_zone(time_zone))`                          |
| `locations_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`           |
| `locations_pkey`                    | `PRIMARY KEY (id)`                                                |
| `locations_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                          |

| Index                           | Definition                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `locations_pkey`                | `CREATE UNIQUE INDEX locations_pkey ON rebook.locations USING btree (id)`                           |
| `locations_tenant_id_id_unique` | `CREATE UNIQUE INDEX locations_tenant_id_id_unique ON rebook.locations USING btree (tenant_id, id)` |

| Policy                       | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ---------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `locations_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT, INSERT, UPDATE, DELETE |

### `rebook.tenant_feature_flags`

Row level security: enabled, forced.

| Column       | Type                       | Nullable | Default |
| ------------ | -------------------------- | -------- | ------- |
| `tenant_id`  | `uuid`                     | no       |         |
| `flag`       | `text`                     | no       |         |
| `enabled`    | `boolean`                  | no       | `false` |
| `updated_at` | `timestamp with time zone` | no       | `now()` |

| Constraint                                     | Definition                                              |
| ---------------------------------------------- | ------------------------------------------------------- |
| `tenant_feature_flags_flag_format`             | `CHECK (flag ~ '^[a-z][a-z0-9_]{1,63}$'::text)`         |
| `tenant_feature_flags_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)` |
| `tenant_feature_flags_pkey`                    | `PRIMARY KEY (tenant_id, flag)`                         |

| Index                       | Definition                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tenant_feature_flags_pkey` | `CREATE UNIQUE INDEX tenant_feature_flags_pkey ON rebook.tenant_feature_flags USING btree (tenant_id, flag)` |

| Policy                                  | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| --------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `tenant_feature_flags_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT, INSERT, UPDATE, DELETE |

### `rebook.tenant_memberships`

Row level security: enabled, forced.

| Column       | Type                       | Nullable | Default                     |
| ------------ | -------------------------- | -------- | --------------------------- |
| `id`         | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`  | `uuid`                     | no       |                             |
| `user_id`    | `uuid`                     | no       |                             |
| `role`       | `text`                     | no       |                             |
| `created_at` | `timestamp with time zone` | no       | `now()`                     |
| `revoked_at` | `timestamp with time zone` | yes      |                             |

| Constraint                                    | Definition                                                 |
| --------------------------------------------- | ---------------------------------------------------------- |
| `tenant_memberships_role_valid`               | `CHECK (role = ANY (ARRAY['owner'::text, 'staff'::text]))` |
| `tenant_memberships_tenant_id_tenants_id_fk`  | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`    |
| `tenant_memberships_pkey`                     | `PRIMARY KEY (id)`                                         |
| `tenant_memberships_tenant_id_id_unique`      | `UNIQUE (tenant_id, id)`                                   |
| `tenant_memberships_tenant_id_user_id_unique` | `UNIQUE (tenant_id, user_id)`                              |

| Index                                         | Definition                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_memberships_pkey`                     | `CREATE UNIQUE INDEX tenant_memberships_pkey ON rebook.tenant_memberships USING btree (id)`                                     |
| `tenant_memberships_tenant_id_id_unique`      | `CREATE UNIQUE INDEX tenant_memberships_tenant_id_id_unique ON rebook.tenant_memberships USING btree (tenant_id, id)`           |
| `tenant_memberships_tenant_id_user_id_unique` | `CREATE UNIQUE INDEX tenant_memberships_tenant_id_user_id_unique ON rebook.tenant_memberships USING btree (tenant_id, user_id)` |
| `tenant_memberships_user_id_idx`              | `CREATE INDEX tenant_memberships_user_id_idx ON rebook.tenant_memberships USING btree (user_id)`                                |

| Policy                      | Command | Roles                         | Using                                                                                                                                                                                                                     | With check                                                                                                   |
| --------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tenant_memberships_delete` | DELETE  | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                              |                                                                                                              |
| `tenant_memberships_insert` | INSERT  | `rebook_app`, `rebook_worker` |                                                                                                                                                                                                                           | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |
| `tenant_memberships_select` | SELECT  | `rebook_app`, `rebook_worker` | `((tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif")) OR (user_id = ( SELECT (NULLIF(current_setting('app.actor_id'::text, true), ''::text))::uuid AS "nullif")))` |                                                                                                              |
| `tenant_memberships_update` | UPDATE  | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                              | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT, INSERT, UPDATE, DELETE |

### `rebook.tenants`

Row level security: enabled, forced.

| Column       | Type                       | Nullable | Default                     |
| ------------ | -------------------------- | -------- | --------------------------- |
| `id`         | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `name`       | `text`                     | no       |                             |
| `slug`       | `text`                     | no       |                             |
| `time_zone`  | `text`                     | no       |                             |
| `created_at` | `timestamp with time zone` | no       | `now()`                     |
| `updated_at` | `timestamp with time zone` | no       | `now()`                     |

| Constraint                | Definition                                                        |
| ------------------------- | ----------------------------------------------------------------- |
| `tenants_name_length`     | `CHECK (length(btrim(name)) >= 1 AND length(btrim(name)) <= 120)` |
| `tenants_slug_format`     | `CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'::text)`   |
| `tenants_time_zone_valid` | `CHECK (rebook.is_time_zone(time_zone))`                          |
| `tenants_pkey`            | `PRIMARY KEY (id)`                                                |
| `tenants_slug_unique`     | `UNIQUE (slug)`                                                   |

| Index                 | Definition                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `tenants_pkey`        | `CREATE UNIQUE INDEX tenants_pkey ON rebook.tenants USING btree (id)`          |
| `tenants_slug_unique` | `CREATE UNIQUE INDEX tenants_slug_unique ON rebook.tenants USING btree (slug)` |

| Policy                   | Command | Roles                         | Using                                                                                                 | With check                                                                                            |
| ------------------------ | ------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tenants_insert_current` | INSERT  | `rebook_app`, `rebook_worker` |                                                                                                       | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |
| `tenants_select_current` | SELECT  | `rebook_app`, `rebook_worker` | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |                                                                                                       |

| Role            | Privileges     |
| --------------- | -------------- |
| `rebook_app`    | SELECT, INSERT |
| `rebook_worker` | SELECT, INSERT |

<!-- generated:end -->
