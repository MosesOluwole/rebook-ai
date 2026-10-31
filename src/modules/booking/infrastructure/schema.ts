import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { locations, rebook, tenants } from '@/modules/tenancy';

import { EXCEPTION_KINDS } from '../domain/availability-exception';
import { BOOKING_MODES, LOCATION_TYPES } from '../domain/service';

/**
 * Booking configuration tables (docs/architecture.md §5 and §6, docs/phases.md Phase 3). Every
 * child of a tenant-owned parent references it as (tenant_id, parent_id) → parent (tenant_id, id),
 * so a row can never point into another tenant. RLS policies, grants, the exclusion constraints
 * on working hours and breaks, the business-type lock trigger and the team member → membership
 * key (which needs ON DELETE SET NULL on one column of a composite key) are hand-written SQL in
 * supabase/migrations.
 */

const uuidV7 = sql`rebook.uuid_generate_v7()`;
const timestamptz = () => timestamp({ withTimezone: true });

export const services = rebook
  .table(
    'services',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      name: text().notNull(),
      bookingMode: text({ enum: BOOKING_MODES }).notNull(),
      durationMinutes: integer().notNull(),
      bufferBeforeMinutes: integer().notNull().default(0),
      bufferAfterMinutes: integer().notNull().default(0),
      /** numeric(12,2): read and written as a decimal string, never a float. */
      price: numeric({ precision: 12, scale: 2 }).notNull(),
      currency: char({ length: 3 }).notNull(),
      locationType: text({ enum: LOCATION_TYPES }).notNull(),
      repeatIntervalDays: integer(),
      published: boolean().notNull().default(false),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('services_tenant_id_id_unique').on(table.tenantId, table.id),
      check('services_name_length', sql`length(btrim(${table.name})) between 1 and 120`),
      check('services_booking_mode_valid', sql`${table.bookingMode} in ('timed', 'request')`),
      check(
        'services_location_type_valid',
        sql`${table.locationType} in ('clinic', 'client_home', 'video', 'venue')`,
      ),
      check('services_duration_range', sql`${table.durationMinutes} between 5 and 1440`),
      check(
        'services_buffers_range',
        sql`${table.bufferBeforeMinutes} between 0 and 240 and ${table.bufferAfterMinutes} between 0 and 240`,
      ),
      check('services_price_not_negative', sql`${table.price} >= 0`),
      check('services_currency_format', sql`${table.currency} ~ '^[A-Z]{3}$'`),
      check(
        'services_repeat_interval_range',
        sql`${table.repeatIntervalDays} is null or ${table.repeatIntervalDays} between 1 and 1095`,
      ),
    ],
  )
  .enableRLS();

export const teamMembers = rebook
  .table(
    'team_members',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      /**
       * The membership this person signs in with, or null for someone who does not sign in.
       * (tenant_id, membership_id) → tenant_memberships (tenant_id, id) ON DELETE SET NULL
       * (membership_id) is hand-written SQL: Drizzle cannot express a column list on SET NULL,
       * and nulling tenant_id with it would break the row.
       */
      membershipId: uuid(),
      displayName: text().notNull(),
      active: boolean().notNull().default(true),
      /** Home visits: minutes added before and after the visit for travel (Phase 4 folds them in). */
      travelBeforeMinutes: integer().notNull().default(0),
      travelAfterMinutes: integer().notNull().default(0),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('team_members_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('team_members_tenant_id_membership_id_unique').on(table.tenantId, table.membershipId),
      check(
        'team_members_display_name_length',
        sql`length(btrim(${table.displayName})) between 1 and 80`,
      ),
      check(
        'team_members_travel_range',
        sql`${table.travelBeforeMinutes} between 0 and 240 and ${table.travelAfterMinutes} between 0 and 240`,
      ),
    ],
  )
  .enableRLS();

/** Which team members may deliver which services. */
export const staffServices = rebook
  .table(
    'staff_services',
    {
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      teamMemberId: uuid().notNull(),
      serviceId: uuid().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'staff_services_pkey',
        columns: [table.tenantId, table.teamMemberId, table.serviceId],
      }),
      foreignKey({
        name: 'staff_services_team_member_fk',
        columns: [table.tenantId, table.teamMemberId],
        foreignColumns: [teamMembers.tenantId, teamMembers.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'staff_services_service_fk',
        columns: [table.tenantId, table.serviceId],
        foreignColumns: [services.tenantId, services.id],
      }).onDelete('cascade'),
      // "Who can deliver this service?" reads by service.
      index('staff_services_tenant_id_service_id_idx').on(table.tenantId, table.serviceId),
    ],
  )
  .enableRLS();

/**
 * Weekly wall-clock rules: weekday plus local times, per team member and location. The zone is
 * the location's; nothing here is an instant. `end_time` may be 24:00 (midnight at day end).
 * Overlapping ranges for one team member on one weekday are refused by the exclusion constraint
 * working_hours_no_overlap (hand-written, needs btree_gist and rebook.time_range).
 */
export const workingHours = rebook
  .table(
    'working_hours',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      teamMemberId: uuid().notNull(),
      locationId: uuid().notNull(),
      weekday: smallint().notNull(),
      startTime: time().notNull(),
      endTime: time().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('working_hours_tenant_id_id_unique').on(table.tenantId, table.id),
      foreignKey({
        name: 'working_hours_team_member_fk',
        columns: [table.tenantId, table.teamMemberId],
        foreignColumns: [teamMembers.tenantId, teamMembers.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'working_hours_location_fk',
        columns: [table.tenantId, table.locationId],
        foreignColumns: [locations.tenantId, locations.id],
      }),
      check('working_hours_weekday_valid', sql`${table.weekday} between 1 and 7`),
      check('working_hours_start_before_end', sql`${table.startTime} < ${table.endTime}`),
      index('working_hours_tenant_id_location_id_idx').on(table.tenantId, table.locationId),
    ],
  )
  .enableRLS();

/** Breaks inside a working range (e.g. lunch), in the same wall-clock terms as the range. */
export const workingHourBreaks = rebook
  .table(
    'working_hour_breaks',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      workingHoursId: uuid().notNull(),
      startTime: time().notNull(),
      endTime: time().notNull(),
    },
    (table) => [
      unique('working_hour_breaks_tenant_id_id_unique').on(table.tenantId, table.id),
      foreignKey({
        name: 'working_hour_breaks_working_hours_fk',
        columns: [table.tenantId, table.workingHoursId],
        foreignColumns: [workingHours.tenantId, workingHours.id],
      }).onDelete('cascade'),
      check('working_hour_breaks_start_before_end', sql`${table.startTime} < ${table.endTime}`),
    ],
  )
  .enableRLS();

/** Time off for one team member, or a closure of a whole location. Stored as instants. */
export const availabilityExceptions = rebook
  .table(
    'availability_exceptions',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      kind: text({ enum: EXCEPTION_KINDS }).notNull(),
      teamMemberId: uuid(),
      locationId: uuid().notNull(),
      startsAt: timestamptz().notNull(),
      endsAt: timestamptz().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('availability_exceptions_tenant_id_id_unique').on(table.tenantId, table.id),
      foreignKey({
        name: 'availability_exceptions_team_member_fk',
        columns: [table.tenantId, table.teamMemberId],
        foreignColumns: [teamMembers.tenantId, teamMembers.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'availability_exceptions_location_fk',
        columns: [table.tenantId, table.locationId],
        foreignColumns: [locations.tenantId, locations.id],
      }),
      check('availability_exceptions_kind_valid', sql`${table.kind} in ('time_off', 'closure')`),
      check(
        'availability_exceptions_kind_subject',
        sql`(${table.kind} = 'time_off') = (${table.teamMemberId} is not null)`,
      ),
      check('availability_exceptions_ends_after_start', sql`${table.endsAt} > ${table.startsAt}`),
      // "Current and upcoming" filters on the end; the team member cascade deletes by member.
      index('availability_exceptions_tenant_id_ends_at_idx').on(table.tenantId, table.endsAt),
      index('availability_exceptions_tenant_id_team_member_id_idx').on(
        table.tenantId,
        table.teamMemberId,
      ),
    ],
  )
  .enableRLS();

/** Postcode districts a team member visits for home appointments. */
export const teamMemberServiceAreas = rebook
  .table(
    'team_member_service_areas',
    {
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      teamMemberId: uuid().notNull(),
      postcodeDistrict: text().notNull(),
    },
    (table) => [
      primaryKey({
        name: 'team_member_service_areas_pkey',
        columns: [table.tenantId, table.teamMemberId, table.postcodeDistrict],
      }),
      foreignKey({
        name: 'team_member_service_areas_team_member_fk',
        columns: [table.tenantId, table.teamMemberId],
        foreignColumns: [teamMembers.tenantId, teamMembers.id],
      }).onDelete('cascade'),
      check(
        'team_member_service_areas_district_format',
        sql`${table.postcodeDistrict} ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'`,
      ),
    ],
  )
  .enableRLS();

/**
 * Events per date for one team member, for request-mode services. Configuration only in Phase 3;
 * Phase 7's per-date `daily_capacity` rows are created from it and enforce it.
 */
export const dailyCapacityRules = rebook
  .table(
    'daily_capacity_rules',
    {
      id: uuid().primaryKey().default(uuidV7),
      tenantId: uuid()
        .notNull()
        .references(() => tenants.id),
      teamMemberId: uuid().notNull(),
      maxEventsPerDate: integer().notNull(),
      createdAt: timestamptz().notNull().defaultNow(),
      updatedAt: timestamptz().notNull().defaultNow(),
    },
    (table) => [
      unique('daily_capacity_rules_tenant_id_id_unique').on(table.tenantId, table.id),
      unique('daily_capacity_rules_tenant_id_team_member_id_unique').on(
        table.tenantId,
        table.teamMemberId,
      ),
      foreignKey({
        name: 'daily_capacity_rules_team_member_fk',
        columns: [table.tenantId, table.teamMemberId],
        foreignColumns: [teamMembers.tenantId, teamMembers.id],
      }).onDelete('cascade'),
      check(
        'daily_capacity_rules_max_events_range',
        sql`${table.maxEventsPerDate} between 1 and 50`,
      ),
    ],
  )
  .enableRLS();
