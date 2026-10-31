import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { services } from '@/modules/booking';
import { rebook, tenants } from '@/modules/tenancy';

import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '../domain/custom-field';

/**
 * Custom fields (docs/architecture.md §5): definitions per entity, and values keyed by
 * (tenant, definition, entity). A value carries its definition's entity and references it through
 * (tenant_id, definition_id, entity), so a service value can never use a client definition. Each
 * entity has its own nullable reference column with a composite key: `service_id` now,
 * `customer_id` when clients arrive in Phase 5. RLS, grants and the health free-text trigger are
 * hand-written SQL in supabase/migrations.
 */

const uuidV7 = sql`rebook.uuid_generate_v7()`;
const timestamptz = () => timestamp({ withTimezone: true });

export const customFieldDefinitions = rebook
  .table(
    'custom_field_definitions',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      entity: text({ enum: CUSTOM_FIELD_ENTITIES }).notNull(),
      key: text().notNull(),
      label: text().notNull(),
      fieldType: text({ enum: CUSTOM_FIELD_TYPES }).notNull(),
      /** Option labels for list types; an empty array otherwise. */
      options: jsonb().$type<string[]>().notNull().default([]),
      required: boolean().notNull().default(false),
      /** An owner's audited decision to allow this free-text field in a health business. */
      healthFreeTextOverride: boolean().notNull().default(false),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('custom_field_definitions_tenant_id_id_unique').on(table.tenantId, table.id),
      // The target of the values' (tenant_id, definition_id, entity) key.
      unique('custom_field_definitions_tenant_id_id_entity_unique').on(
        table.tenantId,
        table.id,
        table.entity,
      ),
      unique('custom_field_definitions_tenant_id_entity_key_unique').on(
        table.tenantId,
        table.entity,
        table.key,
      ),
      check('custom_field_definitions_entity_valid', sql`${table.entity} in ('client', 'service')`),
      check(
        'custom_field_definitions_type_valid',
        sql`${table.fieldType} in ('text', 'long_text', 'number', 'boolean', 'date', 'select', 'multi_select')`,
      ),
      check('custom_field_definitions_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_]{0,39}$'`),
      check(
        'custom_field_definitions_label_length',
        sql`length(btrim(${table.label})) between 1 and 80`,
      ),
      check(
        'custom_field_definitions_options_shape',
        sql`jsonb_typeof(${table.options}) = 'array' and (${table.fieldType} in ('select', 'multi_select')) = (jsonb_array_length(${table.options}) > 0)`,
      ),
      check(
        'custom_field_definitions_override_only_free_text',
        sql`not ${table.healthFreeTextOverride} or ${table.fieldType} in ('text', 'long_text')`,
      ),
    ],
  )
  .enableRLS();

export const customFieldValues = rebook
  .table(
    'custom_field_values',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      definitionId: uuid().notNull(),
      entity: text({ enum: CUSTOM_FIELD_ENTITIES }).notNull(),
      serviceId: uuid(),
      value: jsonb().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('custom_field_values_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('custom_field_values_tenant_id_definition_id_service_id_unique').on(
        table.tenantId,
        table.definitionId,
        table.serviceId,
      ),
      foreignKey({
        name: 'custom_field_values_definition_fk',
        columns: [table.tenantId, table.definitionId, table.entity],
        foreignColumns: [
          customFieldDefinitions.tenantId,
          customFieldDefinitions.id,
          customFieldDefinitions.entity,
        ],
      }).onDelete('cascade'),
      foreignKey({
        name: 'custom_field_values_service_fk',
        columns: [table.tenantId, table.serviceId],
        foreignColumns: [services.tenantId, services.id],
      }).onDelete('cascade'),
      // A service's values are read, cleared and cascaded by service.
      index('custom_field_values_tenant_id_service_id_idx').on(table.tenantId, table.serviceId),
      // Values exist only for services until clients arrive (Phase 5 widens this check).
      check(
        'custom_field_values_subject',
        sql`${table.entity} = 'service' and ${table.serviceId} is not null`,
      ),
    ],
  )
  .enableRLS();
