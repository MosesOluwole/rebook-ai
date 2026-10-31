# Database schema

The `rebook` schema as it exists after the migrations in `supabase/migrations`. The invariants
section is written by hand; the catalogue section is generated from the local database by
`pnpm db:docs` and checked in CI with `pnpm db:docs --check`, so it always matches the migrations
that were committed with it. Decisions behind the shape are in
[ADR-002](./adr/ADR-002-schema-roles-context.md); the design is `docs/architecture.md` §4 and §5.

## Invariants

| Invariant                        | Enforcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Test                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No cross-tenant reads or writes  | RLS enabled and forced on every table; policies on `app.tenant_id`; runtime roles are NOBYPASSRLS                                                                                                                                                                                                                                                                                                                                                                                                                | `tests/integration/tenancy/isolation.generated.test.ts`                                               |
| Context fails closed             | `nullif(current_setting('app.tenant_id', true), '')::uuid` → NULL matches nothing                                                                                                                                                                                                                                                                                                                                                                                                                                | `with-tenant.test.ts` (pooled connection), isolation suite                                            |
| No access outside `withTenant`   | `rebook_authenticator` is NOINHERIT with no table privileges                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `roles-and-grants.test.ts`                                                                            |
| No Data API path                 | `rebook` absent from `[api].schemas`; no grants to `anon`, `authenticated` or `service_role`; CI schema check                                                                                                                                                                                                                                                                                                                                                                                                    | `data-api-config.test.ts`, `roles-and-grants.test.ts`, `schema-check.test.ts`                         |
| No cross-tenant references       | `unique (tenant_id, id)` on every tenant-owned table with an id; children use composite foreign keys; the CI schema check rejects any other foreign key                                                                                                                                                                                                                                                                                                                                                          | `composite-foreign-keys.app-role.test.ts`, `schema-check.test.ts`, isolation suite (catalogue-driven) |
| Audit log is append-only         | runtime roles hold INSERT and SELECT only                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `roles-and-grants.test.ts`                                                                            |
| Ids are time-ordered             | `rebook.uuid_generate_v7()` default; sub-millisecond ordering                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `uuid-v7.test.ts`                                                                                     |
| Time zones are canonical         | Intl canonicalisation at the boundary (ADR-003); `rebook.is_time_zone()` CHECK on `tenants` and `locations` as the last line                                                                                                                                                                                                                                                                                                                                                                                     | `time-zone.test.ts`, `tenant-input-boundary.test.ts`                                                  |
| Every new table is covered       | `pnpm db:check-schema`; generated suite requires a fixture entry                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `schema-check.test.ts`                                                                                |
| Users enter tenants by right     | `withTenant` takes user actors only as `AuthorisedTenantContext` (resolved slug + active membership, or a registration/invitation grant)                                                                                                                                                                                                                                                                                                                                                                         | `tenant-tx-type.test.ts`, `resolve-tenant.test.ts`                                                    |
| Slug misses leak nothing         | `rebook.resolve_tenant_slug()` returns id or null; unknown slug and non-member raise the identical `NotFoundError`                                                                                                                                                                                                                                                                                                                                                                                               | `resolve-tenant.test.ts`, `roles-and-grants.test.ts`                                                  |
| A user sees only their tenants   | actor branches of `tenant_memberships_select` (user actors only) and `tenants_select_member` (only while no tenant is set); the one `UserTx` repository lists memberships                                                                                                                                                                                                                                                                                                                                        | `user-context.test.ts`, `phase2-followups.test.ts`                                                    |
| Memberships are real users       | `tenant_memberships.user_id → auth.users(id) on delete cascade`; invitation user columns `on delete set null`                                                                                                                                                                                                                                                                                                                                                                                                    | `phase2-followups.test.ts`                                                                            |
| Owner-only commands              | `can(role, permission)` checked first in every application command; typed `PermissionDeniedError`                                                                                                                                                                                                                                                                                                                                                                                                                | `permissions.test.ts`                                                                                 |
| Invite tokens are secrets        | 256-bit token, SHA-256 stored, one-time, 7-day expiry; acceptance by the verified addressee only; every bad link is the same 404                                                                                                                                                                                                                                                                                                                                                                                 | `invitations.test.ts`                                                                                 |
| Slugs never change               | trigger `tenants_slug_immutable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `isolation.generated.test.ts`                                                                         |
| Health businesses stay health    | `updateBusinessSettings` refuses midwife → non-health (`BusinessTypeChangeError`); trigger `tenants_business_type_health_lock` as backstop                                                                                                                                                                                                                                                                                                                                                                       | `business-type.test.ts`                                                                               |
| One open invitation per address  | `createInvitation` refuses a duplicate; partial unique index `tenant_invitations_open_email_unique`; active members cannot accept (`AlreadyMemberError`)                                                                                                                                                                                                                                                                                                                                                         | `invitations.test.ts`                                                                                 |
| Auth attempts are rate limited   | `rebook.rate_limits` + `rebook.rate_limit_hit()` through `withAnonymousContext`; keyed on hashed client IP and email; 429 with one generic message                                                                                                                                                                                                                                                                                                                                                               | `tests/integration/platform/rate-limits.test.ts`, `tests/e2e/rate-limits.spec.ts`                     |
| Child keys pair tenant_id        | every child of a tenant-owned parent references `(tenant_id, parent_id) → parent (tenant_id, id)` (Phase 3: services, team, schedules, custom fields); the CI schema check fails a key into a tenant-owned parent that does not map `tenant_id` to the parent's `tenant_id`                                                                                                                                                                                                                                      | `schema-check.test.ts`, isolation suite, `tests/integration/booking/configuration.test.ts`            |
| Business type locked by services | `updateBusinessSettings` refuses a type change once any service exists (`BusinessTypeLockedError`), with the tenant row locked against concurrent service creation; trigger `tenants_business_type_service_lock` as backstop                                                                                                                                                                                                                                                                                     | `tests/integration/booking/business-type-lock.test.ts`                                                |
| No overlapping working hours     | exclusion constraints `working_hours_no_overlap` (team member, weekday, `rebook.time_range`) and `working_hour_breaks_no_overlap`; the domain refuses overlaps first with field errors                                                                                                                                                                                                                                                                                                                           | `configuration.test.ts` (unit and integration)                                                        |
| Unpublished services are hidden  | `services_select` policy shows unpublished services only to `user`, `worker` and `system` actors; unpublishing is a flag change, never a delete                                                                                                                                                                                                                                                                                                                                                                  | `tests/integration/booking/configuration.test.ts`                                                     |
| Revoked members stay on the team | onboarding creates the owner's team member in its transaction (`onboardingHooks`); trigger `tenant_memberships_unlink_team_member` nulls the link on revocation, keeping hours and time off                                                                                                                                                                                                                                                                                                                      | `tests/integration/booking/team-membership.test.ts`                                                   |
| Health custom-field rules        | No client-scoped fields for health businesses (`HealthClientFieldError`); a free-text service field needs `custom_fields.health_override` and writes `custom_field.health_override_enabled`; trigger `custom_field_definitions_health_rules` (every health trigger asks `rebook.is_health_business_type()`, mirrored by `isHealthBusiness`); becoming a health business with client or un-overridden free-text fields is refused (`HealthCustomFieldsError`, trigger `tenants_business_type_custom_fields_lock`) | `tests/integration/crm/custom-fields.test.ts`                                                         |
| Custom values match definitions  | Zod schema built per definition at write time; values reference `(tenant_id, definition_id, entity)` so a service value cannot use a client definition                                                                                                                                                                                                                                                                                                                                                           | `custom-field.test.ts`, `tests/integration/crm/custom-fields.test.ts`                                 |
| Money is never a float           | `numeric(12,2)` plus `char(3)` currency; amounts stay decimal strings; > 2 decimals and unknown ISO 4217 codes refused at the boundary                                                                                                                                                                                                                                                                                                                                                                           | `configuration.test.ts`                                                                               |

## Request context

| Setting          | `withTenant` sets it from | `withUserContext` sets it to            | Read by                                                                   |
| ---------------- | ------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `app.tenant_id`  | `ctx.tenantId` (UUID)     | `''` (fails every tenant policy closed) | every policy                                                              |
| `app.actor_id`   | `ctx.actorId` or `''`     | the user's id                           | actor branches of `tenant_memberships_select` and `tenants_select_member` |
| `app.actor_kind` | `ctx.actorKind`           | `'user'`                                | the same actor branches (user actors only); audit entries                 |
| `app.request_id` | `ctx.requestId`           | the request id                          | audit entries (via the repository)                                        |

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

| Function                                                                                                         | Returns                  | Volatility | Purpose                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rebook.custom_field_definitions_health_rules()`                                                                 | `trigger`                | volatile   | Trigger: in a health business, rejects client-scoped custom fields and free-text fields without the override.                    |
| `rebook.is_health_business_type(business_type text)`                                                             | `boolean`                | immutable  | True for health business types (neutral messaging, no clinical or client custom fields). Mirrors isHealthBusiness in the domain. |
| `rebook.is_time_zone(zone text)`                                                                                 | `boolean`                | immutable  | True when the argument is an IANA time zone name known to Postgres (Area/Location form, or UTC).                                 |
| `rebook.rate_limit_hit(p_key text, p_window_seconds integer, p_max_hits integer, p_at timestamp with time zone)` | `boolean`                | volatile   | Counts one hit in the fixed window containing p_at; true while within p_max_hits. Executable by rebook_app only.                 |
| `rebook.resolve_tenant_slug(slug text)`                                                                          | `uuid`                   | stable     | Tenant id for a URL slug, or null. SECURITY DEFINER with empty search_path; executable by rebook_app only.                       |
| `rebook.services_lock_tenant()`                                                                                  | `trigger`                | volatile   | Trigger: share-locks the tenant row while a service is inserted, serialising it with business type changes.                      |
| `rebook.tenant_memberships_unlink_team_member()`                                                                 | `trigger`                | volatile   | Trigger: unlinks the team member of a membership when the membership is revoked.                                                 |
| `rebook.tenants_business_type_custom_fields_lock()`                                                              | `trigger`                | volatile   | Trigger: rejects becoming a health business while client custom fields or un-overridden free-text fields exist.                  |
| `rebook.tenants_business_type_health_lock()`                                                                     | `trigger`                | volatile   | Trigger: rejects changing a health business type to a non-health type (rebook.is_health_business_type).                          |
| `rebook.tenants_business_type_service_lock()`                                                                    | `trigger`                | volatile   | Trigger: rejects a business_type change while the tenant has any service.                                                        |
| `rebook.tenants_slug_immutable()`                                                                                | `trigger`                | volatile   | Trigger: rejects any change to tenants.slug.                                                                                     |
| `rebook.time_multirange(VARIADIC rebook.time_range[])`                                                           | `rebook.time_multirange` | immutable  |                                                                                                                                  |
| `rebook.time_multirange(rebook.time_range)`                                                                      | `rebook.time_multirange` | immutable  |                                                                                                                                  |
| `rebook.time_multirange()`                                                                                       | `rebook.time_multirange` | immutable  |                                                                                                                                  |
| `rebook.time_range(time without time zone, time without time zone, text)`                                        | `rebook.time_range`      | immutable  |                                                                                                                                  |
| `rebook.time_range(time without time zone, time without time zone)`                                              | `rebook.time_range`      | immutable  |                                                                                                                                  |
| `rebook.uuid_generate_v7()`                                                                                      | `uuid`                   | volatile   | UUIDv7 with sub-millisecond ordering (RFC 9562 §6.2 method 3). Default for every primary key.                                    |

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

### `rebook.availability_exceptions`

Row level security: enabled, forced.

| Column           | Type                       | Nullable | Default                     |
| ---------------- | -------------------------- | -------- | --------------------------- |
| `id`             | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`      | `uuid`                     | no       |                             |
| `kind`           | `text`                     | no       |                             |
| `team_member_id` | `uuid`                     | yes      |                             |
| `location_id`    | `uuid`                     | no       |                             |
| `starts_at`      | `timestamp with time zone` | no       |                             |
| `ends_at`        | `timestamp with time zone` | no       |                             |
| `created_at`     | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                        | Definition                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `availability_exceptions_ends_after_start`        | `CHECK (ends_at > starts_at)`                                                                             |
| `availability_exceptions_kind_subject`            | `CHECK ((kind = 'time_off'::text) = (team_member_id IS NOT NULL))`                                        |
| `availability_exceptions_kind_valid`              | `CHECK (kind = ANY (ARRAY['time_off'::text, 'closure'::text]))`                                           |
| `availability_exceptions_location_fk`             | `FOREIGN KEY (tenant_id, location_id) REFERENCES rebook.locations(tenant_id, id)`                         |
| `availability_exceptions_team_member_fk`          | `FOREIGN KEY (tenant_id, team_member_id) REFERENCES rebook.team_members(tenant_id, id) ON DELETE CASCADE` |
| `availability_exceptions_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                   |
| `availability_exceptions_pkey`                    | `PRIMARY KEY (id)`                                                                                        |
| `availability_exceptions_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                                                                  |

| Index                                                  | Definition                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability_exceptions_pkey`                         | `CREATE UNIQUE INDEX availability_exceptions_pkey ON rebook.availability_exceptions USING btree (id)`                                         |
| `availability_exceptions_tenant_id_ends_at_idx`        | `CREATE INDEX availability_exceptions_tenant_id_ends_at_idx ON rebook.availability_exceptions USING btree (tenant_id, ends_at)`               |
| `availability_exceptions_tenant_id_id_unique`          | `CREATE UNIQUE INDEX availability_exceptions_tenant_id_id_unique ON rebook.availability_exceptions USING btree (tenant_id, id)`               |
| `availability_exceptions_tenant_id_team_member_id_idx` | `CREATE INDEX availability_exceptions_tenant_id_team_member_id_idx ON rebook.availability_exceptions USING btree (tenant_id, team_member_id)` |

| Policy                                     | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ------------------------------------------ | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `availability_exceptions_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.custom_field_definitions`

Row level security: enabled, forced.

| Column                      | Type                       | Nullable | Default                     |
| --------------------------- | -------------------------- | -------- | --------------------------- |
| `id`                        | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`                 | `uuid`                     | no       |                             |
| `entity`                    | `text`                     | no       |                             |
| `key`                       | `text`                     | no       |                             |
| `label`                     | `text`                     | no       |                             |
| `field_type`                | `text`                     | no       |                             |
| `options`                   | `jsonb`                    | no       | `'[]'::jsonb`               |
| `required`                  | `boolean`                  | no       | `false`                     |
| `health_free_text_override` | `boolean`                  | no       | `false`                     |
| `created_at`                | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`                | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                             | Definition                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom_field_definitions_entity_valid`                | `CHECK (entity = ANY (ARRAY['client'::text, 'service'::text]))`                                                                                          |
| `custom_field_definitions_key_format`                  | `CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'::text)`                                                                                                           |
| `custom_field_definitions_label_length`                | `CHECK (length(btrim(label)) >= 1 AND length(btrim(label)) <= 80)`                                                                                       |
| `custom_field_definitions_options_shape`               | `CHECK (jsonb_typeof(options) = 'array'::text AND (field_type = ANY (ARRAY['select'::text, 'multi_select'::text])) = (jsonb_array_length(options) > 0))` |
| `custom_field_definitions_override_only_free_text`     | `CHECK (NOT health_free_text_override OR (field_type = ANY (ARRAY['text'::text, 'long_text'::text])))`                                                   |
| `custom_field_definitions_type_valid`                  | `CHECK (field_type = ANY (ARRAY['text'::text, 'long_text'::text, 'number'::text, 'boolean'::text, 'date'::text, 'select'::text, 'multi_select'::text]))` |
| `custom_field_definitions_tenant_id_tenants_id_fk`     | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                                                  |
| `custom_field_definitions_pkey`                        | `PRIMARY KEY (id)`                                                                                                                                       |
| `custom_field_definitions_tenant_id_entity_key_unique` | `UNIQUE (tenant_id, entity, key)`                                                                                                                        |
| `custom_field_definitions_tenant_id_id_entity_unique`  | `UNIQUE (tenant_id, id, entity)`                                                                                                                         |
| `custom_field_definitions_tenant_id_id_unique`         | `UNIQUE (tenant_id, id)`                                                                                                                                 |

| Index                                                  | Definition                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom_field_definitions_pkey`                        | `CREATE UNIQUE INDEX custom_field_definitions_pkey ON rebook.custom_field_definitions USING btree (id)`                                            |
| `custom_field_definitions_tenant_id_entity_key_unique` | `CREATE UNIQUE INDEX custom_field_definitions_tenant_id_entity_key_unique ON rebook.custom_field_definitions USING btree (tenant_id, entity, key)` |
| `custom_field_definitions_tenant_id_id_entity_unique`  | `CREATE UNIQUE INDEX custom_field_definitions_tenant_id_id_entity_unique ON rebook.custom_field_definitions USING btree (tenant_id, id, entity)`   |
| `custom_field_definitions_tenant_id_id_unique`         | `CREATE UNIQUE INDEX custom_field_definitions_tenant_id_id_unique ON rebook.custom_field_definitions USING btree (tenant_id, id)`                  |

| Policy                                      | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ------------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `custom_field_definitions_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.custom_field_values`

Row level security: enabled, forced.

| Column          | Type                       | Nullable | Default                     |
| --------------- | -------------------------- | -------- | --------------------------- |
| `id`            | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`     | `uuid`                     | no       |                             |
| `definition_id` | `uuid`                     | no       |                             |
| `entity`        | `text`                     | no       |                             |
| `service_id`    | `uuid`                     | yes      |                             |
| `value`         | `jsonb`                    | no       |                             |
| `created_at`    | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`    | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                                      | Definition                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `custom_field_values_subject`                                   | `CHECK (entity = 'service'::text AND service_id IS NOT NULL)`                                                                        |
| `custom_field_values_definition_fk`                             | `FOREIGN KEY (tenant_id, definition_id, entity) REFERENCES rebook.custom_field_definitions(tenant_id, id, entity) ON DELETE CASCADE` |
| `custom_field_values_service_fk`                                | `FOREIGN KEY (tenant_id, service_id) REFERENCES rebook.services(tenant_id, id) ON DELETE CASCADE`                                    |
| `custom_field_values_tenant_id_tenants_id_fk`                   | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                              |
| `custom_field_values_pkey`                                      | `PRIMARY KEY (id)`                                                                                                                   |
| `custom_field_values_tenant_id_definition_id_service_id_unique` | `UNIQUE (tenant_id, definition_id, service_id)`                                                                                      |
| `custom_field_values_tenant_id_id_unique`                       | `UNIQUE (tenant_id, id)`                                                                                                             |

| Index                                                           | Definition                                                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom_field_values_pkey`                                      | `CREATE UNIQUE INDEX custom_field_values_pkey ON rebook.custom_field_values USING btree (id)`                                                                        |
| `custom_field_values_tenant_id_definition_id_service_id_unique` | `CREATE UNIQUE INDEX custom_field_values_tenant_id_definition_id_service_id_unique ON rebook.custom_field_values USING btree (tenant_id, definition_id, service_id)` |
| `custom_field_values_tenant_id_id_unique`                       | `CREATE UNIQUE INDEX custom_field_values_tenant_id_id_unique ON rebook.custom_field_values USING btree (tenant_id, id)`                                              |
| `custom_field_values_tenant_id_service_id_idx`                  | `CREATE INDEX custom_field_values_tenant_id_service_id_idx ON rebook.custom_field_values USING btree (tenant_id, service_id)`                                        |

| Policy                                 | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| -------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `custom_field_values_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.daily_capacity_rules`

Row level security: enabled, forced.

| Column                | Type                       | Nullable | Default                     |
| --------------------- | -------------------------- | -------- | --------------------------- |
| `id`                  | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`           | `uuid`                     | no       |                             |
| `team_member_id`      | `uuid`                     | no       |                             |
| `max_events_per_date` | `integer`                  | no       |                             |
| `created_at`          | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`          | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                             | Definition                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `daily_capacity_rules_max_events_range`                | `CHECK (max_events_per_date >= 1 AND max_events_per_date <= 50)`                                          |
| `daily_capacity_rules_team_member_fk`                  | `FOREIGN KEY (tenant_id, team_member_id) REFERENCES rebook.team_members(tenant_id, id) ON DELETE CASCADE` |
| `daily_capacity_rules_tenant_id_tenants_id_fk`         | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                   |
| `daily_capacity_rules_pkey`                            | `PRIMARY KEY (id)`                                                                                        |
| `daily_capacity_rules_tenant_id_id_unique`             | `UNIQUE (tenant_id, id)`                                                                                  |
| `daily_capacity_rules_tenant_id_team_member_id_unique` | `UNIQUE (tenant_id, team_member_id)`                                                                      |

| Index                                                  | Definition                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily_capacity_rules_pkey`                            | `CREATE UNIQUE INDEX daily_capacity_rules_pkey ON rebook.daily_capacity_rules USING btree (id)`                                                   |
| `daily_capacity_rules_tenant_id_id_unique`             | `CREATE UNIQUE INDEX daily_capacity_rules_tenant_id_id_unique ON rebook.daily_capacity_rules USING btree (tenant_id, id)`                         |
| `daily_capacity_rules_tenant_id_team_member_id_unique` | `CREATE UNIQUE INDEX daily_capacity_rules_tenant_id_team_member_id_unique ON rebook.daily_capacity_rules USING btree (tenant_id, team_member_id)` |

| Policy                                  | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| --------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `daily_capacity_rules_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

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

### `rebook.rate_limits`

Fixed-window counters for rate limiting, keyed by hashed scope:kind:value. No tenant_id by design.

Row level security: enabled, forced.

| Column           | Type                       | Nullable | Default |
| ---------------- | -------------------------- | -------- | ------- |
| `key`            | `text`                     | no       |         |
| `window_start`   | `timestamp with time zone` | no       |         |
| `window_seconds` | `integer`                  | no       |         |
| `count`          | `integer`                  | no       | `0`     |

| Constraint                       | Definition                             |
| -------------------------------- | -------------------------------------- |
| `rate_limits_count_not_negative` | `CHECK (count >= 0)`                   |
| `rate_limits_key_format`         | `CHECK (key ~ '^[0-9a-f]{64}$'::text)` |
| `rate_limits_window_positive`    | `CHECK (window_seconds > 0)`           |
| `rate_limits_pkey`               | `PRIMARY KEY (key, window_start)`      |

| Index              | Definition                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `rate_limits_pkey` | `CREATE UNIQUE INDEX rate_limits_pkey ON rebook.rate_limits USING btree (key, window_start)` |

| Policy                   | Command | Roles        | Using  | With check |
| ------------------------ | ------- | ------------ | ------ | ---------- |
| `rate_limits_app_access` | ALL     | `rebook_app` | `true` | `true`     |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | none                           |

### `rebook.services`

Row level security: enabled, forced.

| Column                  | Type                       | Nullable | Default                     |
| ----------------------- | -------------------------- | -------- | --------------------------- |
| `id`                    | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`             | `uuid`                     | no       |                             |
| `name`                  | `text`                     | no       |                             |
| `booking_mode`          | `text`                     | no       |                             |
| `duration_minutes`      | `integer`                  | no       |                             |
| `buffer_before_minutes` | `integer`                  | no       | `0`                         |
| `buffer_after_minutes`  | `integer`                  | no       | `0`                         |
| `price`                 | `numeric(12,2)`            | no       |                             |
| `currency`              | `character(3)`             | no       |                             |
| `location_type`         | `text`                     | no       |                             |
| `repeat_interval_days`  | `integer`                  | yes      |                             |
| `published`             | `boolean`                  | no       | `false`                     |
| `created_at`            | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`            | `timestamp with time zone` | no       | `now()`                     |

| Constraint                         | Definition                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `services_booking_mode_valid`      | `CHECK (booking_mode = ANY (ARRAY['timed'::text, 'request'::text]))`                                                                |
| `services_buffers_range`           | `CHECK (buffer_before_minutes >= 0 AND buffer_before_minutes <= 240 AND buffer_after_minutes >= 0 AND buffer_after_minutes <= 240)` |
| `services_currency_format`         | `CHECK (currency ~ '^[A-Z]{3}$'::text)`                                                                                             |
| `services_duration_range`          | `CHECK (duration_minutes >= 5 AND duration_minutes <= 1440)`                                                                        |
| `services_location_type_valid`     | `CHECK (location_type = ANY (ARRAY['clinic'::text, 'client_home'::text, 'video'::text, 'venue'::text]))`                            |
| `services_name_length`             | `CHECK (length(btrim(name)) >= 1 AND length(btrim(name)) <= 120)`                                                                   |
| `services_price_not_negative`      | `CHECK (price >= 0::numeric)`                                                                                                       |
| `services_repeat_interval_range`   | `CHECK (repeat_interval_days IS NULL OR repeat_interval_days >= 1 AND repeat_interval_days <= 1095)`                                |
| `services_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                             |
| `services_pkey`                    | `PRIMARY KEY (id)`                                                                                                                  |
| `services_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                                                                                            |

| Index                          | Definition                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `services_pkey`                | `CREATE UNIQUE INDEX services_pkey ON rebook.services USING btree (id)`                           |
| `services_tenant_id_id_unique` | `CREATE UNIQUE INDEX services_tenant_id_id_unique ON rebook.services USING btree (tenant_id, id)` |

| Policy            | Command | Roles                         | Using                                                                                                                                                                                                                                                                      | With check                                                                                                   |
| ----------------- | ------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `services_delete` | DELETE  | `rebook_app`                  | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                               |                                                                                                              |
| `services_insert` | INSERT  | `rebook_app`                  |                                                                                                                                                                                                                                                                            | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |
| `services_select` | SELECT  | `rebook_app`, `rebook_worker` | `((tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif")) AND (published OR (( SELECT current_setting('app.actor_kind'::text, true) AS current_setting) = ANY (ARRAY['user'::text, 'worker'::text, 'system'::text]))))` |                                                                                                              |
| `services_update` | UPDATE  | `rebook_app`                  | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                               | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.staff_services`

Row level security: enabled, forced.

| Column           | Type                       | Nullable | Default |
| ---------------- | -------------------------- | -------- | ------- |
| `tenant_id`      | `uuid`                     | no       |         |
| `team_member_id` | `uuid`                     | no       |         |
| `service_id`     | `uuid`                     | no       |         |
| `created_at`     | `timestamp with time zone` | no       | `now()` |

| Constraint                               | Definition                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `staff_services_service_fk`              | `FOREIGN KEY (tenant_id, service_id) REFERENCES rebook.services(tenant_id, id) ON DELETE CASCADE`         |
| `staff_services_team_member_fk`          | `FOREIGN KEY (tenant_id, team_member_id) REFERENCES rebook.team_members(tenant_id, id) ON DELETE CASCADE` |
| `staff_services_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                   |
| `staff_services_pkey`                    | `PRIMARY KEY (tenant_id, team_member_id, service_id)`                                                     |

| Index                                     | Definition                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `staff_services_pkey`                     | `CREATE UNIQUE INDEX staff_services_pkey ON rebook.staff_services USING btree (tenant_id, team_member_id, service_id)` |
| `staff_services_tenant_id_service_id_idx` | `CREATE INDEX staff_services_tenant_id_service_id_idx ON rebook.staff_services USING btree (tenant_id, service_id)`    |

| Policy                            | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| --------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `staff_services_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.team_member_service_areas`

Row level security: enabled, forced.

| Column              | Type   | Nullable | Default |
| ------------------- | ------ | -------- | ------- |
| `tenant_id`         | `uuid` | no       |         |
| `team_member_id`    | `uuid` | no       |         |
| `postcode_district` | `text` | no       |         |

| Constraint                                          | Definition                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `team_member_service_areas_district_format`         | `CHECK (postcode_district ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'::text)`                                          |
| `team_member_service_areas_team_member_fk`          | `FOREIGN KEY (tenant_id, team_member_id) REFERENCES rebook.team_members(tenant_id, id) ON DELETE CASCADE` |
| `team_member_service_areas_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                   |
| `team_member_service_areas_pkey`                    | `PRIMARY KEY (tenant_id, team_member_id, postcode_district)`                                              |

| Index                            | Definition                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team_member_service_areas_pkey` | `CREATE UNIQUE INDEX team_member_service_areas_pkey ON rebook.team_member_service_areas USING btree (tenant_id, team_member_id, postcode_district)` |

| Policy                                       | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| -------------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `team_member_service_areas_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.team_members`

Row level security: enabled, forced.

| Column                  | Type                       | Nullable | Default                     |
| ----------------------- | -------------------------- | -------- | --------------------------- |
| `id`                    | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`             | `uuid`                     | no       |                             |
| `membership_id`         | `uuid`                     | yes      |                             |
| `display_name`          | `text`                     | no       |                             |
| `active`                | `boolean`                  | no       | `true`                      |
| `travel_before_minutes` | `integer`                  | no       | `0`                         |
| `travel_after_minutes`  | `integer`                  | no       | `0`                         |
| `created_at`            | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`            | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                    | Definition                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `team_members_display_name_length`            | `CHECK (length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 80)`                                                    |
| `team_members_travel_range`                   | `CHECK (travel_before_minutes >= 0 AND travel_before_minutes <= 240 AND travel_after_minutes >= 0 AND travel_after_minutes <= 240)` |
| `team_members_membership_fk`                  | `FOREIGN KEY (tenant_id, membership_id) REFERENCES rebook.tenant_memberships(tenant_id, id) ON DELETE SET NULL (membership_id)`     |
| `team_members_tenant_id_tenants_id_fk`        | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                             |
| `team_members_pkey`                           | `PRIMARY KEY (id)`                                                                                                                  |
| `team_members_tenant_id_id_unique`            | `UNIQUE (tenant_id, id)`                                                                                                            |
| `team_members_tenant_id_membership_id_unique` | `UNIQUE (tenant_id, membership_id)`                                                                                                 |

| Index                                         | Definition                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `team_members_pkey`                           | `CREATE UNIQUE INDEX team_members_pkey ON rebook.team_members USING btree (id)`                                                 |
| `team_members_tenant_id_id_unique`            | `CREATE UNIQUE INDEX team_members_tenant_id_id_unique ON rebook.team_members USING btree (tenant_id, id)`                       |
| `team_members_tenant_id_membership_id_unique` | `CREATE UNIQUE INDEX team_members_tenant_id_membership_id_unique ON rebook.team_members USING btree (tenant_id, membership_id)` |

| Policy                          | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `team_members_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

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

### `rebook.tenant_invitations`

Row level security: enabled, forced.

| Column        | Type                       | Nullable | Default                     |
| ------------- | -------------------------- | -------- | --------------------------- |
| `id`          | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`   | `uuid`                     | no       |                             |
| `email`       | `text`                     | no       |                             |
| `role`        | `text`                     | no       |                             |
| `token_hash`  | `text`                     | no       |                             |
| `invited_by`  | `uuid`                     | yes      |                             |
| `expires_at`  | `timestamp with time zone` | no       |                             |
| `accepted_at` | `timestamp with time zone` | yes      |                             |
| `accepted_by` | `uuid`                     | yes      |                             |
| `revoked_at`  | `timestamp with time zone` | yes      |                             |
| `created_at`  | `timestamp with time zone` | no       | `now()`                     |

| Constraint                                       | Definition                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_invitations_email_format`                | `CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text AND length(email) <= 320)` |
| `tenant_invitations_role_valid`                  | `CHECK (role = ANY (ARRAY['owner'::text, 'staff'::text]))`                                                                         |
| `tenant_invitations_token_hash_format`           | `CHECK (token_hash ~ '^[0-9a-f]{64}$'::text)`                                                                                      |
| `tenant_invitations_accepted_by_auth_users_fk`   | `FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL`                                                           |
| `tenant_invitations_invited_by_auth_users_fk`    | `FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL`                                                            |
| `tenant_invitations_tenant_id_tenants_id_fk`     | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                            |
| `tenant_invitations_pkey`                        | `PRIMARY KEY (id)`                                                                                                                 |
| `tenant_invitations_tenant_id_id_unique`         | `UNIQUE (tenant_id, id)`                                                                                                           |
| `tenant_invitations_tenant_id_token_hash_unique` | `UNIQUE (tenant_id, token_hash)`                                                                                                   |

| Index                                            | Definition                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_invitations_open_email_unique`           | `CREATE UNIQUE INDEX tenant_invitations_open_email_unique ON rebook.tenant_invitations USING btree (tenant_id, lower(email)) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL))` |
| `tenant_invitations_pkey`                        | `CREATE UNIQUE INDEX tenant_invitations_pkey ON rebook.tenant_invitations USING btree (id)`                                                                                          |
| `tenant_invitations_tenant_id_id_unique`         | `CREATE UNIQUE INDEX tenant_invitations_tenant_id_id_unique ON rebook.tenant_invitations USING btree (tenant_id, id)`                                                                |
| `tenant_invitations_tenant_id_token_hash_unique` | `CREATE UNIQUE INDEX tenant_invitations_tenant_id_token_hash_unique ON rebook.tenant_invitations USING btree (tenant_id, token_hash)`                                                |

| Policy                                | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| ------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `tenant_invitations_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges             |
| --------------- | ---------------------- |
| `rebook_app`    | SELECT, INSERT, UPDATE |
| `rebook_worker` | SELECT                 |

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

| Constraint                                    | Definition                                                          |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `tenant_memberships_role_valid`               | `CHECK (role = ANY (ARRAY['owner'::text, 'staff'::text]))`          |
| `tenant_memberships_tenant_id_tenants_id_fk`  | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`             |
| `tenant_memberships_user_id_auth_users_fk`    | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `tenant_memberships_pkey`                     | `PRIMARY KEY (id)`                                                  |
| `tenant_memberships_tenant_id_id_unique`      | `UNIQUE (tenant_id, id)`                                            |
| `tenant_memberships_tenant_id_user_id_unique` | `UNIQUE (tenant_id, user_id)`                                       |

| Index                                         | Definition                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_memberships_pkey`                     | `CREATE UNIQUE INDEX tenant_memberships_pkey ON rebook.tenant_memberships USING btree (id)`                                     |
| `tenant_memberships_tenant_id_id_unique`      | `CREATE UNIQUE INDEX tenant_memberships_tenant_id_id_unique ON rebook.tenant_memberships USING btree (tenant_id, id)`           |
| `tenant_memberships_tenant_id_user_id_unique` | `CREATE UNIQUE INDEX tenant_memberships_tenant_id_user_id_unique ON rebook.tenant_memberships USING btree (tenant_id, user_id)` |
| `tenant_memberships_user_id_idx`              | `CREATE INDEX tenant_memberships_user_id_idx ON rebook.tenant_memberships USING btree (user_id)`                                |

| Policy                      | Command | Roles                         | Using                                                                                                                                                                                                                                                                                                                       | With check                                                                                                   |
| --------------------------- | ------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tenant_memberships_delete` | DELETE  | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                                                                                |                                                                                                              |
| `tenant_memberships_insert` | INSERT  | `rebook_app`, `rebook_worker` |                                                                                                                                                                                                                                                                                                                             | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |
| `tenant_memberships_select` | SELECT  | `rebook_app`, `rebook_worker` | `((tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif")) OR ((( SELECT current_setting('app.actor_kind'::text, true) AS current_setting) = 'user'::text) AND (user_id = ( SELECT (NULLIF(current_setting('app.actor_id'::text, true), ''::text))::uuid AS "nullif"))))` |                                                                                                              |
| `tenant_memberships_update` | UPDATE  | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                                                                                | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT, INSERT, UPDATE, DELETE |

### `rebook.tenants`

Row level security: enabled, forced.

| Column          | Type                       | Nullable | Default                     |
| --------------- | -------------------------- | -------- | --------------------------- |
| `id`            | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `name`          | `text`                     | no       |                             |
| `slug`          | `text`                     | no       |                             |
| `time_zone`     | `text`                     | no       |                             |
| `created_at`    | `timestamp with time zone` | no       | `now()`                     |
| `updated_at`    | `timestamp with time zone` | no       | `now()`                     |
| `business_type` | `text`                     | no       |                             |

| Constraint                    | Definition                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `tenants_business_type_valid` | `CHECK (business_type = ANY (ARRAY['event_planner'::text, 'midwife'::text, 'other_timed'::text]))` |
| `tenants_name_length`         | `CHECK (length(btrim(name)) >= 1 AND length(btrim(name)) <= 120)`                                  |
| `tenants_slug_format`         | `CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'::text)`                                    |
| `tenants_time_zone_valid`     | `CHECK (rebook.is_time_zone(time_zone))`                                                           |
| `tenants_pkey`                | `PRIMARY KEY (id)`                                                                                 |
| `tenants_slug_unique`         | `UNIQUE (slug)`                                                                                    |

| Index                 | Definition                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `tenants_pkey`        | `CREATE UNIQUE INDEX tenants_pkey ON rebook.tenants USING btree (id)`          |
| `tenants_slug_unique` | `CREATE UNIQUE INDEX tenants_slug_unique ON rebook.tenants USING btree (slug)` |

| Policy                   | Command | Roles                         | Using                                                                                                                                                                                                                                                                                                                                                                                                                                    | With check                                                                                            |
| ------------------------ | ------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tenants_insert_current` | INSERT  | `rebook_app`, `rebook_worker` |                                                                                                                                                                                                                                                                                                                                                                                                                                          | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |
| `tenants_select_current` | SELECT  | `rebook_app`, `rebook_worker` | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                                                                                                                                                                                                    |                                                                                                       |
| `tenants_select_member`  | SELECT  | `rebook_app`                  | `((( SELECT current_setting('app.actor_kind'::text, true) AS current_setting) = 'user'::text) AND (( SELECT NULLIF(current_setting('app.tenant_id'::text, true), ''::text) AS "nullif") IS NULL) AND (EXISTS ( SELECT 1 FROM rebook.tenant_memberships m WHERE ((m.tenant_id = tenants.id) AND (m.user_id = ( SELECT (NULLIF(current_setting('app.actor_id'::text, true), ''::text))::uuid AS "nullif")) AND (m.revoked_at IS NULL)))))` |                                                                                                       |
| `tenants_update_current` | UPDATE  | `rebook_app`                  | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`                                                                                                                                                                                                                                                                                                                                    | `(id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges             |
| --------------- | ---------------------- |
| `rebook_app`    | SELECT, INSERT, UPDATE |
| `rebook_worker` | SELECT, INSERT         |

### `rebook.working_hour_breaks`

Row level security: enabled, forced.

| Column             | Type                     | Nullable | Default                     |
| ------------------ | ------------------------ | -------- | --------------------------- |
| `id`               | `uuid`                   | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`        | `uuid`                   | no       |                             |
| `working_hours_id` | `uuid`                   | no       |                             |
| `start_time`       | `time without time zone` | no       |                             |
| `end_time`         | `time without time zone` | no       |                             |

| Constraint                                    | Definition                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `working_hour_breaks_start_before_end`        | `CHECK (start_time < end_time)`                                                                                   |
| `working_hour_breaks_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                           |
| `working_hour_breaks_working_hours_fk`        | `FOREIGN KEY (tenant_id, working_hours_id) REFERENCES rebook.working_hours(tenant_id, id) ON DELETE CASCADE`      |
| `working_hour_breaks_pkey`                    | `PRIMARY KEY (id)`                                                                                                |
| `working_hour_breaks_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                                                                          |
| `working_hour_breaks_no_overlap`              | `EXCLUDE USING gist (tenant_id WITH =, working_hours_id WITH =, rebook.time_range(start_time, end_time) WITH &&)` |

| Index                                     | Definition                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working_hour_breaks_no_overlap`          | `CREATE INDEX working_hour_breaks_no_overlap ON rebook.working_hour_breaks USING gist (tenant_id, working_hours_id, rebook.time_range(start_time, end_time))` |
| `working_hour_breaks_pkey`                | `CREATE UNIQUE INDEX working_hour_breaks_pkey ON rebook.working_hour_breaks USING btree (id)`                                                                 |
| `working_hour_breaks_tenant_id_id_unique` | `CREATE UNIQUE INDEX working_hour_breaks_tenant_id_id_unique ON rebook.working_hour_breaks USING btree (tenant_id, id)`                                       |

| Policy                                 | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| -------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `working_hour_breaks_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

### `rebook.working_hours`

Row level security: enabled, forced.

| Column           | Type                       | Nullable | Default                     |
| ---------------- | -------------------------- | -------- | --------------------------- |
| `id`             | `uuid`                     | no       | `rebook.uuid_generate_v7()` |
| `tenant_id`      | `uuid`                     | no       |                             |
| `team_member_id` | `uuid`                     | no       |                             |
| `location_id`    | `uuid`                     | no       |                             |
| `weekday`        | `smallint`                 | no       |                             |
| `start_time`     | `time without time zone`   | no       |                             |
| `end_time`       | `time without time zone`   | no       |                             |
| `created_at`     | `timestamp with time zone` | no       | `now()`                     |

| Constraint                              | Definition                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `working_hours_start_before_end`        | `CHECK (start_time < end_time)`                                                                                                 |
| `working_hours_weekday_valid`           | `CHECK (weekday >= 1 AND weekday <= 7)`                                                                                         |
| `working_hours_location_fk`             | `FOREIGN KEY (tenant_id, location_id) REFERENCES rebook.locations(tenant_id, id)`                                               |
| `working_hours_team_member_fk`          | `FOREIGN KEY (tenant_id, team_member_id) REFERENCES rebook.team_members(tenant_id, id) ON DELETE CASCADE`                       |
| `working_hours_tenant_id_tenants_id_fk` | `FOREIGN KEY (tenant_id) REFERENCES rebook.tenants(id)`                                                                         |
| `working_hours_pkey`                    | `PRIMARY KEY (id)`                                                                                                              |
| `working_hours_tenant_id_id_unique`     | `UNIQUE (tenant_id, id)`                                                                                                        |
| `working_hours_no_overlap`              | `EXCLUDE USING gist (tenant_id WITH =, team_member_id WITH =, weekday WITH =, rebook.time_range(start_time, end_time) WITH &&)` |

| Index                                     | Definition                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working_hours_no_overlap`                | `CREATE INDEX working_hours_no_overlap ON rebook.working_hours USING gist (tenant_id, team_member_id, weekday, rebook.time_range(start_time, end_time))` |
| `working_hours_pkey`                      | `CREATE UNIQUE INDEX working_hours_pkey ON rebook.working_hours USING btree (id)`                                                                        |
| `working_hours_tenant_id_id_unique`       | `CREATE UNIQUE INDEX working_hours_tenant_id_id_unique ON rebook.working_hours USING btree (tenant_id, id)`                                              |
| `working_hours_tenant_id_location_id_idx` | `CREATE INDEX working_hours_tenant_id_location_id_idx ON rebook.working_hours USING btree (tenant_id, location_id)`                                      |

| Policy                           | Command | Roles                         | Using                                                                                                        | With check                                                                                                   |
| -------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `working_hours_tenant_isolation` | ALL     | `rebook_app`, `rebook_worker` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` | `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))` |

| Role            | Privileges                     |
| --------------- | ------------------------------ |
| `rebook_app`    | SELECT, INSERT, UPDATE, DELETE |
| `rebook_worker` | SELECT                         |

<!-- generated:end -->
