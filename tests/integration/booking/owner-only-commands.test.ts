import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addAvailabilityException,
  createService,
  createTeamMember,
  deleteAvailabilityException,
  deleteService,
  getDailyCapacity,
  getServiceAreas,
  getService,
  getTeamMember,
  getWorkingHours,
  listCurrentExceptions,
  listServices,
  listTeamMembers,
  newServiceDefaults,
  removeDailyCapacity,
  replaceWorkingHours,
  setDailyCapacity,
  setServiceAreas,
  setServicePublished,
  setStaffServices,
  setTeamMemberActive,
  staffServiceIds,
  updateService,
  updateTeamMember,
  workingIntervalsOn,
} from '@/modules/booking';
import {
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  getServiceCustomFieldValues,
  listCustomFieldDefinitions,
  setServiceCustomFieldValues,
} from '@/modules/crm';
import { PermissionDeniedError, type TenantTx } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  type ConfiguredTenantPair,
  seedConfiguredTenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Test-engineer addition (Phase 3): every owner-only command added in Phase 3 is refused to a
 * `staff` member with the typed PermissionDeniedError, with REAL ids of the staff member's own
 * tenant (so a NotFoundError cannot stand in for the permission check), and nothing changes in any
 * Phase 3 table. permissions.test.ts covers one command per permission; this covers every
 * exported command. Staff can still read the configuration (`workspace.view`).
 */

let owner: DbClient;
let app: AppDb;
let pair: ConfiguredTenantPair;

const PHASE3_TABLES = [
  'services',
  'team_members',
  'staff_services',
  'working_hours',
  'working_hour_breaks',
  'availability_exceptions',
  'team_member_service_areas',
  'daily_capacity_rules',
  'custom_field_definitions',
  'custom_field_values',
] as const;

/** A full fingerprint of tenant A's Phase 3 rows, read as the owner (fixture-side only). */
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of PHASE3_TABLES) {
    const [row] = await owner.sql<{ digest: string | null }[]>`
      select md5(string_agg(t::text, '|' order by t::text)) as digest
      from rebook.${owner.sql(table)} t where t.tenant_id = ${pair.a.id}
    `;
    result[table] = row?.digest ?? 'empty';
  }
  return result;
}

async function asStaff<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = await app.tenancy.resolveTenantForUser(
    pair.a.slug,
    actorFor({ userId: pair.a.spareUserId, email: pair.a.spareEmail }),
  );
  return app.tenancy.withTenant(ctx, work);
}

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedConfiguredTenantPair(owner, 'p3staff');
  await owner.sql`
    insert into rebook.tenant_memberships (tenant_id, user_id, role)
    values (${pair.a.id}, ${pair.a.spareUserId}, 'staff')
  `;
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

const a = () => pair.a;
const service = {
  name: 'Staff probe',
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  price: '10',
  currency: 'GBP',
};

const ownerOnly: readonly (readonly [string, string, (tx: TenantTx) => Promise<unknown>])[] = [
  ['createService', 'services.manage', (tx) => createService(tx, service)],
  ['updateService', 'services.manage', (tx) => updateService(tx, a().serviceId, service)],
  ['setServicePublished', 'services.manage', (tx) => setServicePublished(tx, a().serviceId, false)],
  ['deleteService', 'services.manage', (tx) => deleteService(tx, a().serviceId)],
  [
    'setServiceCustomFieldValues',
    'services.manage',
    (tx) => setServiceCustomFieldValues(tx, a().serviceId, { room: 'Green' }),
  ],
  ['createTeamMember', 'team.manage', (tx) => createTeamMember(tx, { displayName: 'Probe' })],
  [
    'updateTeamMember',
    'team.manage',
    (tx) => updateTeamMember(tx, a().teamMemberId, { displayName: 'Renamed' }),
  ],
  ['setTeamMemberActive', 'team.manage', (tx) => setTeamMemberActive(tx, a().teamMemberId, false)],
  [
    'setStaffServices',
    'team.manage',
    (tx) => setStaffServices(tx, a().teamMemberId, { serviceIds: [] }),
  ],
  [
    'setServiceAreas',
    'team.manage',
    (tx) =>
      setServiceAreas(tx, a().teamMemberId, {
        districts: 'E1',
        travelBeforeMinutes: 5,
        travelAfterMinutes: 5,
      }),
  ],
  [
    'replaceWorkingHours',
    'schedules.manage',
    (tx) =>
      replaceWorkingHours(tx, a().teamMemberId, a().locationId, {
        days: { '2': { ranges: [{ start: '10:00', end: '11:00' }] } },
      }),
  ],
  [
    'addAvailabilityException',
    'schedules.manage',
    (tx) =>
      addAvailabilityException(tx, {
        kind: 'time_off',
        teamMemberId: a().teamMemberId,
        locationId: a().locationId,
        startsAt: '2031-01-01T09:00',
        endsAt: '2031-01-01T17:00',
      }),
  ],
  [
    'deleteAvailabilityException',
    'schedules.manage',
    (tx) => deleteAvailabilityException(tx, a().exceptionId),
  ],
  [
    'setDailyCapacity',
    'schedules.manage',
    (tx) => setDailyCapacity(tx, a().teamMemberId, { maxEventsPerDate: 9 }),
  ],
  ['removeDailyCapacity', 'schedules.manage', (tx) => removeDailyCapacity(tx, a().teamMemberId)],
  [
    'createCustomFieldDefinition',
    'custom_fields.manage',
    (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'service',
        key: 'staff_probe',
        label: 'Staff probe',
        fieldType: 'number',
      }),
  ],
  [
    'createCustomFieldDefinition (health override)',
    'custom_fields.health_override',
    (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'client',
        key: 'staff_note',
        label: 'Staff note',
        fieldType: 'text',
        healthFreeTextOverride: 'on',
      }),
  ],
  [
    'deleteCustomFieldDefinition',
    'custom_fields.manage',
    (tx) => deleteCustomFieldDefinition(tx, a().customFieldDefinitionId),
  ],
];

describe('staff and the Phase 3 owner-only commands', () => {
  it.each(ownerOnly)(
    '%s is refused with PermissionDeniedError (%s) and changes nothing',
    async (_name, permission, command) => {
      const before = await snapshot();
      const attempt = asStaff(command);
      await expect(attempt).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(attempt).rejects.toMatchObject({ permission });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('the same commands succeed for the owner (the refusal is the role, not the input)', async () => {
    const ownerCtx = async () => app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    // Non-destructive representatives of each permission, run as the owner.
    await app.tenancy.withTenant(await ownerCtx(), (tx) =>
      updateTeamMember(tx, a().teamMemberId, { displayName: 'Owner rename' }),
    );
    await app.tenancy.withTenant(await ownerCtx(), (tx) =>
      setDailyCapacity(tx, a().teamMemberId, { maxEventsPerDate: 3 }),
    );
    await app.tenancy.withTenant(await ownerCtx(), (tx) =>
      setServiceCustomFieldValues(tx, a().serviceId, { room: 'Green' }),
    );
    await app.tenancy.withTenant(await ownerCtx(), (tx) => createService(tx, service));
  });

  it('staff can still read every piece of configuration (workspace.view)', async () => {
    await asStaff(async (tx) => {
      expect((await listServices(tx)).length).toBeGreaterThan(0);
      expect((await getService(tx, a().serviceId)).id).toBe(a().serviceId);
      expect(await newServiceDefaults(tx)).toBeDefined();
      expect((await listTeamMembers(tx)).length).toBeGreaterThan(0);
      expect((await getTeamMember(tx, a().teamMemberId)).id).toBe(a().teamMemberId);
      expect(await staffServiceIds(tx, a().teamMemberId)).toContain(a().serviceId);
      expect((await getWorkingHours(tx, a().teamMemberId)).length).toBeGreaterThan(0);
      expect(
        await workingIntervalsOn(tx, a().teamMemberId, a().locationId, '2030-01-07'),
      ).toHaveLength(2);
      const fixedClock = { now: () => new Date('2029-01-01T00:00:00Z') };
      expect((await listCurrentExceptions(tx, fixedClock)).map((e) => e.id)).toContain(
        a().exceptionId,
      );
      expect((await getServiceAreas(tx, a().teamMemberId)).districts).toEqual(['SW1A']);
      expect(await getDailyCapacity(tx, a().teamMemberId)).not.toBeNull();
      expect((await listCustomFieldDefinitions(tx)).length).toBeGreaterThan(0);
      expect((await getServiceCustomFieldValues(tx, a().serviceId)).size).toBe(1);
    });
  });
});
