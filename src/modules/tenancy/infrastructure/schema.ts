import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { BUSINESS_TYPES } from '../domain/business-type';
import { MEMBERSHIP_ROLES } from '../domain/permissions';

/**
 * Tenancy tables (docs/architecture.md §5, docs/adr/ADR-002-schema-roles-context.md).
 *
 * Everything lives in the `rebook` schema, which the Supabase Data API does not expose.
 * Roles, the UUIDv7 function, RLS policies and grants are hand-written SQL in
 * supabase/migrations; this file is the source for `pnpm db:generate` table diffs and for the
 * typed query builder. Column names are snake_case through the `casing` setting.
 */
export const rebook = pgSchema('rebook');

const uuidV7 = sql`rebook.uuid_generate_v7()`;
const timestamptz = () => timestamp({ withTimezone: true });

export const tenants = rebook
  .table(
    'tenants',
    {
      id: uuid().primaryKey().default(uuidV7),
      name: text().notNull(),
      slug: text().notNull().unique(),
      /** Terminology and the health flag derive from this in domain code; nothing else is stored. */
      businessType: text({ enum: BUSINESS_TYPES }).notNull(),
      timeZone: text().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      check('tenants_name_length', sql`length(btrim(${table.name})) between 1 and 120`),
      check('tenants_slug_format', sql`${table.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
      check(
        'tenants_business_type_valid',
        sql`${table.businessType} in ('event_planner', 'midwife', 'other_timed')`,
      ),
      check('tenants_time_zone_valid', sql`rebook.is_time_zone(${table.timeZone})`),
    ],
  )
  .enableRLS();

export const locations = rebook
  .table(
    'locations',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      name: text().notNull(),
      timeZone: text().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('locations_tenant_id_id_unique').on(table.tenantId, table.id),
      check('locations_name_length', sql`length(btrim(${table.name})) between 1 and 120`),
      check('locations_time_zone_valid', sql`rebook.is_time_zone(${table.timeZone})`),
    ],
  )
  .enableRLS();

export const tenantMemberships = rebook
  .table(
    'tenant_memberships',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      /**
       * Supabase Auth user id. References auth.users(id) on delete cascade; the constraint is
       * hand-written SQL (Phase 2 migration) because auth.users is not a Drizzle-managed table.
       */
      userId: uuid().notNull(),
      role: text({ enum: MEMBERSHIP_ROLES }).notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
      revokedAt: timestamptz(),
    },
    (table) => [
      unique('tenant_memberships_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('tenant_memberships_tenant_id_user_id_unique').on(table.tenantId, table.userId),
      // The select policy and listForCurrentActor look a user up across tenants.
      index('tenant_memberships_user_id_idx').on(table.userId),
      check('tenant_memberships_role_valid', sql`${table.role} in ('owner', 'staff')`),
    ],
  )
  .enableRLS();

export const tenantInvitations = rebook
  .table(
    'tenant_invitations',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      /** Lower-cased at the boundary; compared with the signed-in user's verified email on acceptance. */
      email: text().notNull(),
      role: text({ enum: MEMBERSHIP_ROLES }).notNull(),
      /** SHA-256 (hex) of the 256-bit token in the invite link. The token itself is never stored. */
      tokenHash: text().notNull(),
      /** auth.users(id), on delete set null (hand-written constraint). */
      invitedBy: uuid(),
      expiresAt: timestamptz().notNull(),
      acceptedAt: timestamptz(),
      /** auth.users(id), on delete set null (hand-written constraint). */
      acceptedBy: uuid(),
      revokedAt: timestamptz(),
      createdAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('tenant_invitations_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('tenant_invitations_tenant_id_token_hash_unique').on(table.tenantId, table.tokenHash),
      // One open invitation per address per tenant: the partial unique index
      // tenant_invitations_open_email_unique on (tenant_id, lower(email)) where accepted_at and
      // revoked_at are null is kept hand-written beside the policies (migration 174913). Do not
      // add it here as well, or the next `db:generate` emits a duplicate.
      check(
        'tenant_invitations_email_format',
        sql`${table.email} = lower(btrim(${table.email})) and ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' and length(${table.email}) <= 320`,
      ),
      check('tenant_invitations_role_valid', sql`${table.role} in ('owner', 'staff')`),
      check('tenant_invitations_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    ],
  )
  .enableRLS();

export const auditLogs = rebook
  .table(
    'audit_logs',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      actorKind: text().notNull(),
      actorId: uuid(),
      requestId: text(),
      action: text().notNull(),
      entityType: text().notNull(),
      entityId: uuid(),
      before: jsonb(),
      after: jsonb(),
      createdAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('audit_logs_tenant_id_id_unique').on(table.tenantId, table.id),
      // listRecent reads a tenant's newest entries first.
      index('audit_logs_tenant_id_created_at_idx').on(table.tenantId, table.createdAt.desc()),
      check(
        'audit_logs_actor_kind_valid',
        sql`${table.actorKind} in ('user', 'customer', 'anonymous', 'worker', 'system')`,
      ),
      check('audit_logs_action_format', sql`${table.action} ~ '^[a-z_]+(?:\\.[a-z_]+)+$'`),
    ],
  )
  .enableRLS();

export const tenantFeatureFlags = rebook
  .table(
    'tenant_feature_flags',
    {
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      flag: text().notNull(),
      enabled: boolean().notNull().default(false),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      primaryKey({ name: 'tenant_feature_flags_pkey', columns: [table.tenantId, table.flag] }),
      check('tenant_feature_flags_flag_format', sql`${table.flag} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    ],
  )
  .enableRLS();

export const idempotencyKeys = rebook
  .table(
    'idempotency_keys',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      scope: text().notNull(),
      key: text().notNull(),
      requestHash: text().notNull(),
      responseStatus: integer(),
      responseBody: jsonb(),
      createdAt: timestamptz().notNull().defaultNow(),
      expiresAt: timestamptz().notNull(),
    },
    (table) => [
      unique('idempotency_keys_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('idempotency_keys_tenant_id_scope_key_unique').on(
        table.tenantId,
        table.scope,
        table.key,
      ),
    ],
  )
  .enableRLS();
