import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addAvailabilityException,
  createService,
  createTeamMember,
  deleteAvailabilityException,
  getDailyCapacity,
  getServiceAreas,
  getService,
  getTeamMember,
  getWorkingHours,
  listPublishedServices,
  listServices,
  removeDailyCapacity,
  replaceWorkingHours,
  setDailyCapacity,
  setServiceAreas,
  setServicePublished,
  setStaffServices,
  staffServiceIds,
  updateService,
  updateTeamMember,
  workingIntervalsOn,
} from '@/modules/booking';
import { deleteCustomFieldDefinition, getServiceCustomFieldValues } from '@/modules/crm';
import { NotFoundError, type TenantTx, ValidationError } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  expectSqlState,
  FOREIGN_KEY_VIOLATION,
} from '../../helpers/sql-state';
import {
  actorFor,
  type ConfiguredTenantPair,
  contextFor,
  seedConfiguredTenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Phase 3 acceptance criteria exercised through the application commands as the tenant owner
 * (the production path) against the real database:
 *
 * - invalid configuration is rejected server-side with field-level errors;
 * - a service cannot be assigned to a team member of another tenant (composite keys);
 * - 09:00–17:00 Europe/London is stored as wall-clock rules and resolves across DST;
 * - unpublishing hides a service from public reads and keeps everything that references it;
 * - another tenant's ids are a NotFoundError in every command (the isolation of the new routes,
 *   which call these commands with ids from the URL or form).
 */

let owner: DbClient;
let app: AppDb;
let pair: ConfiguredTenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedConfiguredTenantPair(owner, 'cfg');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

async function asOwnerA<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
  return app.tenancy.withTenant(ctx, work);
}

async function fieldErrors(attempt: Promise<unknown>): Promise<Record<string, readonly string[]>> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).fieldErrors;
  }
  throw new Error('expected a ValidationError');
}

const validService = {
  name: 'Postnatal visit',
  durationMinutes: '60',
  bufferBeforeMinutes: '10',
  bufferAfterMinutes: '10',
  price: '75.50',
  currency: 'GBP',
  locationType: 'client_home',
};

describe('invalid configuration is rejected server-side with field-level errors', () => {
  it('services: negative duration, buffers over 4 hours, 3 decimals, unknown currency', async () => {
    const errors = await fieldErrors(
      asOwnerA((tx) =>
        createService(tx, {
          ...validService,
          durationMinutes: '-15',
          bufferBeforeMinutes: '300',
          price: '75.505',
          currency: 'ABC',
        }),
      ),
    );
    expect(errors).toMatchObject({
      durationMinutes: ['must be between 5 and 1440 minutes'],
      bufferBeforeMinutes: ['must be between 0 and 240 minutes'],
      price: ['at most 2 decimal places'],
      currency: ['an ISO 4217 currency code in current use, such as GBP or EUR'],
    });
    const names = (await asOwnerA((tx) => listServices(tx))).map((s) => s.name);
    expect(names).not.toContain('Postnatal visit');
  });

  it('the database refuses the same values if the application were bypassed', async () => {
    for (const statement of [
      sql`insert into rebook.services (tenant_id, name, booking_mode, duration_minutes, price, currency, location_type) values (${pair.a.id}, 'x', 'timed', -5, 1, 'GBP', 'clinic')`,
      sql`insert into rebook.services (tenant_id, name, booking_mode, duration_minutes, buffer_before_minutes, price, currency, location_type) values (${pair.a.id}, 'x', 'timed', 30, 241, 1, 'GBP', 'clinic')`,
      sql`insert into rebook.services (tenant_id, name, booking_mode, duration_minutes, price, currency, location_type) values (${pair.a.id}, 'x', 'timed', 30, 1, 'gb', 'clinic')`,
    ]) {
      await expectSqlState(
        app.tenancy.withTenant(contextFor(pair.a.id), (tx) => tx.db.execute(statement)),
        CHECK_VIOLATION,
      );
    }
    // numeric(12,2) rounds a third decimal: the application refuses it before it gets here.
    const [row] = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ price: string }>(sql`select 10.555::numeric(12,2)::text as price`),
    );
    expect(row?.price).toBe('10.56');
  });

  it('working hours: overlapping ranges on one day, keyed by the input path', async () => {
    const errors = await fieldErrors(
      asOwnerA((tx) =>
        replaceWorkingHours(tx, pair.a.teamMemberId, pair.a.locationId, {
          days: {
            '3': {
              ranges: [
                { start: '09:00', end: '12:30' },
                { start: '12:00', end: '17:00' },
              ],
            },
          },
        }),
      ),
    );
    expect(errors).toEqual({
      'days.3.ranges.1.start': ['overlaps another working range on Wednesday'],
    });
    // Nothing was replaced: the seeded Monday range is still there.
    const stored = await asOwnerA((tx) => getWorkingHours(tx, pair.a.teamMemberId));
    expect(stored.map((r) => [r.weekday, r.start, r.end])).toEqual([[1, 540, 1020]]);
  });

  it('working hours: an overlap with the same person at another location (exclusion constraint)', async () => {
    const [second] = await owner.sql<{ id: string }[]>`
      insert into rebook.locations (tenant_id, name, time_zone)
      values (${pair.a.id}, 'Second clinic', 'Europe/London') returning id
    `;
    if (second === undefined) {
      throw new Error('fixture: location');
    }
    const errors = await fieldErrors(
      asOwnerA((tx) =>
        replaceWorkingHours(tx, pair.a.teamMemberId, second.id, {
          days: { '1': { ranges: [{ start: '16:00', end: '19:00' }] } },
        }),
      ),
    );
    expect(errors['']).toEqual([
      'overlaps working hours this team member already has at another location on the same day',
    ]);
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.working_hours (tenant_id, team_member_id, location_id, weekday, start_time, end_time) values (${pair.a.id}, ${pair.a.teamMemberId}, ${pair.a.locationId}, 1, '16:00', '18:00')`,
        ),
      ),
      EXCLUSION_VIOLATION,
    );
    await owner.sql`delete from rebook.locations where id = ${second.id}`;
  });

  it('daily capacity: refused outside 1–50, stored and removable inside', async () => {
    expect(
      await fieldErrors(
        asOwnerA((tx) => setDailyCapacity(tx, pair.a.teamMemberId, { maxEventsPerDate: '0' })),
      ),
    ).toHaveProperty('maxEventsPerDate');
    expect(
      await fieldErrors(
        asOwnerA((tx) => setDailyCapacity(tx, pair.a.teamMemberId, { maxEventsPerDate: '51' })),
      ),
    ).toHaveProperty('maxEventsPerDate');
    const rule = await asOwnerA((tx) =>
      setDailyCapacity(tx, pair.a.teamMemberId, { maxEventsPerDate: '4' }),
    );
    expect(rule.maxEventsPerDate).toBe(4);
    await asOwnerA((tx) => removeDailyCapacity(tx, pair.a.teamMemberId));
    expect(await asOwnerA((tx) => getDailyCapacity(tx, pair.a.teamMemberId))).toBeNull();
  });

  it('service areas: districts normalised, travel minutes stored on the team member', async () => {
    await asOwnerA((tx) =>
      setServiceAreas(tx, pair.a.teamMemberId, {
        districts: 'n1, e8 N1',
        travelBeforeMinutes: '20',
        travelAfterMinutes: '15',
      }),
    );
    expect(await asOwnerA((tx) => getServiceAreas(tx, pair.a.teamMemberId))).toEqual({
      districts: ['E8', 'N1'],
      travelBeforeMinutes: 20,
      travelAfterMinutes: 15,
    });
    expect(
      await fieldErrors(
        asOwnerA((tx) =>
          setServiceAreas(tx, pair.a.teamMemberId, {
            districts: 'N1 9GU',
            travelBeforeMinutes: '0',
            travelAfterMinutes: '0',
          }),
        ),
      ),
    ).toHaveProperty('districts');
  });
});

describe('composite keys: no assignment across tenants', () => {
  it('refuses to make tenant B service eligible for a tenant A team member', async () => {
    await expect(
      asOwnerA((tx) =>
        setStaffServices(tx, pair.a.teamMemberId, { serviceIds: [pair.b.serviceId] }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The database refuses it as well, whatever the application does.
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.staff_services (tenant_id, team_member_id, service_id) values (${pair.a.id}, ${pair.a.teamMemberId}, ${pair.b.serviceId})`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.staff_services (tenant_id, team_member_id, service_id) values (${pair.a.id}, ${pair.b.teamMemberId}, ${pair.a.serviceId})`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
    expect(await asOwnerA((tx) => staffServiceIds(tx, pair.a.teamMemberId))).toEqual([
      pair.a.serviceId,
    ]);
  });

  it('refuses to link a team member to another tenant membership', async () => {
    await expect(
      asOwnerA((tx) =>
        createTeamMember(tx, { displayName: 'Imposter', membershipId: pair.b.membershipId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to link one membership to two team members', async () => {
    const errors = await fieldErrors(
      asOwnerA((tx) =>
        createTeamMember(tx, { displayName: 'Twin', membershipId: pair.a.membershipId }),
      ),
    );
    expect(errors.membershipId).toEqual(['already linked to another team member']);
  });

  it('keeps the team member when its membership disappears, nulling only the link', async () => {
    const [membership] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.a.id}, ${pair.a.spareUserId}, 'staff') returning id
    `;
    const member = await asOwnerA((tx) =>
      createTeamMember(tx, { displayName: 'Spare', membershipId: membership?.id }),
    );
    await owner.sql`delete from rebook.tenant_memberships where id = ${membership?.id ?? ''}`;
    const after = await asOwnerA((tx) => getTeamMember(tx, member.id));
    expect(after).toMatchObject({ id: member.id, tenantId: pair.a.id, membershipId: null });
  });
});

describe('another tenant ids are not found in any command', () => {
  const b = () => pair.b;
  it.each([
    ['getService', (tx: TenantTx) => getService(tx, b().serviceId)],
    ['updateService', (tx: TenantTx) => updateService(tx, b().serviceId, validService)],
    ['setServicePublished', (tx: TenantTx) => setServicePublished(tx, b().serviceId, false)],
    ['getTeamMember', (tx: TenantTx) => getTeamMember(tx, b().teamMemberId)],
    [
      'updateTeamMember',
      (tx: TenantTx) => updateTeamMember(tx, b().teamMemberId, { displayName: 'x' }),
    ],
    [
      'setStaffServices',
      (tx: TenantTx) => setStaffServices(tx, b().teamMemberId, { serviceIds: [] }),
    ],
    ['getWorkingHours', (tx: TenantTx) => getWorkingHours(tx, b().teamMemberId)],
    [
      'replaceWorkingHours (member)',
      (tx: TenantTx) => replaceWorkingHours(tx, b().teamMemberId, pair.a.locationId, { days: {} }),
    ],
    [
      'replaceWorkingHours (location)',
      (tx: TenantTx) => replaceWorkingHours(tx, pair.a.teamMemberId, b().locationId, { days: {} }),
    ],
    [
      'addAvailabilityException (location)',
      (tx: TenantTx) =>
        addAvailabilityException(tx, {
          kind: 'closure',
          locationId: b().locationId,
          startsAt: '2031-01-01T09:00',
          endsAt: '2031-01-01T17:00',
        }),
    ],
    [
      'addAvailabilityException (team member)',
      (tx: TenantTx) =>
        addAvailabilityException(tx, {
          kind: 'time_off',
          teamMemberId: b().teamMemberId,
          locationId: pair.a.locationId,
          startsAt: '2031-01-01T09:00',
          endsAt: '2031-01-01T17:00',
        }),
    ],
    [
      'deleteAvailabilityException',
      (tx: TenantTx) => deleteAvailabilityException(tx, b().exceptionId),
    ],
    [
      'setServiceAreas',
      (tx: TenantTx) =>
        setServiceAreas(tx, b().teamMemberId, {
          districts: '',
          travelBeforeMinutes: 0,
          travelAfterMinutes: 0,
        }),
    ],
    [
      'setDailyCapacity',
      (tx: TenantTx) => setDailyCapacity(tx, b().teamMemberId, { maxEventsPerDate: 2 }),
    ],
    [
      'getServiceCustomFieldValues',
      (tx: TenantTx) => getServiceCustomFieldValues(tx, b().serviceId),
    ],
  ] as const)('%s', async (_name, command: (tx: TenantTx) => Promise<unknown>) => {
    await expect(asOwnerA(command)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('left tenant B untouched', async () => {
    const [row] = await owner.sql<{ published: boolean; name: string }[]>`
      select published, name from rebook.services where id = ${pair.b.serviceId}
    `;
    expect(row).toEqual({ published: true, name: 'Fixture service' });
  });
});

describe('a malformed id is not found (never a database cast error)', () => {
  const bad = 'not-a-uuid';
  it.each([
    ['getService', (tx: TenantTx) => getService(tx, bad)],
    ['updateService', (tx: TenantTx) => updateService(tx, bad, validService)],
    ['setServicePublished', (tx: TenantTx) => setServicePublished(tx, bad, true)],
    ['getTeamMember', (tx: TenantTx) => getTeamMember(tx, bad)],
    ['updateTeamMember', (tx: TenantTx) => updateTeamMember(tx, bad, { displayName: 'x' })],
    ['setStaffServices', (tx: TenantTx) => setStaffServices(tx, bad, { serviceIds: [] })],
    ['staffServiceIds', (tx: TenantTx) => staffServiceIds(tx, bad)],
    [
      'replaceWorkingHours (member)',
      (tx: TenantTx) => replaceWorkingHours(tx, bad, pair.a.locationId, { days: {} }),
    ],
    [
      'replaceWorkingHours (location)',
      (tx: TenantTx) => replaceWorkingHours(tx, pair.a.teamMemberId, bad, { days: {} }),
    ],
    ['getWorkingHours', (tx: TenantTx) => getWorkingHours(tx, bad)],
    ['deleteAvailabilityException', (tx: TenantTx) => deleteAvailabilityException(tx, bad)],
    ['getDailyCapacity', (tx: TenantTx) => getDailyCapacity(tx, bad)],
    ['getServiceCustomFieldValues', (tx: TenantTx) => getServiceCustomFieldValues(tx, bad)],
    ['deleteCustomFieldDefinition', (tx: TenantTx) => deleteCustomFieldDefinition(tx, bad)],
  ] as const)('%s', async (_name, command: (tx: TenantTx) => Promise<unknown>) => {
    await expect(asOwnerA(command)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('working hours are wall-clock rules resolved in the location zone', () => {
  it('stores 09:00–17:00 Europe/London as times and resolves across the 2026 and 2027 changes', async () => {
    const member = await asOwnerA((tx) => createTeamMember(tx, { displayName: 'DST tester' }));
    const week = Object.fromEntries(
      ['1', '2', '3', '4', '5', '6', '7'].map((d) => [
        d,
        { ranges: [{ start: '09:00', end: '17:00' }] },
      ]),
    );
    await asOwnerA((tx) => replaceWorkingHours(tx, member.id, pair.a.locationId, { days: week }));

    const stored = await owner.sql<{ start_time: string; end_time: string }[]>`
      select distinct start_time::text, end_time::text from rebook.working_hours
      where team_member_id = ${member.id}
    `;
    expect(stored).toEqual([{ start_time: '09:00:00', end_time: '17:00:00' }]);

    const utc = async (date: string) =>
      (await asOwnerA((tx) => workingIntervalsOn(tx, member.id, pair.a.locationId, date))).map(
        (i) => `${i.start.toISOString().slice(11, 16)}–${i.end.toISOString().slice(11, 16)}`,
      );
    for (const [before, sunday, after, beforeUtc, afterUtc] of [
      ['2026-03-28', '2026-03-29', '2026-03-30', '09:00–17:00', '08:00–16:00'],
      ['2026-10-24', '2026-10-25', '2026-10-26', '08:00–16:00', '09:00–17:00'],
      ['2027-03-27', '2027-03-28', '2027-03-29', '09:00–17:00', '08:00–16:00'],
      ['2027-10-30', '2027-10-31', '2027-11-01', '08:00–16:00', '09:00–17:00'],
    ] as const) {
      expect(await utc(before), before).toEqual([beforeUtc]);
      expect(await utc(sunday), sunday).toEqual([afterUtc]);
      expect(await utc(after), after).toEqual([afterUtc]);
    }
  });

  it('stores time off as instants from local times in the location zone', async () => {
    const exception = await asOwnerA((tx) =>
      addAvailabilityException(tx, {
        kind: 'time_off',
        teamMemberId: pair.a.teamMemberId,
        locationId: pair.a.locationId,
        startsAt: '2026-07-01T09:00',
        endsAt: '2026-07-03T17:00',
      }),
    );
    expect(exception.startsAt.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(exception.endsAt.toISOString()).toBe('2026-07-03T16:00:00.000Z');
  });
});

describe('unpublishing a service', () => {
  it('hides it from public reads, in the query and in RLS, and keeps what references it', async () => {
    const anonymous = contextFor(pair.a.id, { actorKind: 'anonymous' });
    const publicIds = async () =>
      (await app.tenancy.withTenant(anonymous, (tx) => listPublishedServices(tx))).map((s) => s.id);
    expect(await publicIds()).toContain(pair.a.serviceId);

    await asOwnerA((tx) => setServicePublished(tx, pair.a.serviceId, false));

    expect(await publicIds()).not.toContain(pair.a.serviceId);
    // RLS: even an unfiltered select by id finds nothing for public actors.
    for (const actorKind of ['anonymous', 'customer'] as const) {
      const actorId = actorKind === 'customer' ? randomUUID() : null;
      const rows = await app.tenancy.withTenant(
        contextFor(pair.a.id, { actorKind, actorId }),
        (tx) => tx.db.execute(sql`select 1 from rebook.services where id = ${pair.a.serviceId}`),
      );
      expect(rows, actorKind).toHaveLength(0);
    }
    // Members still see it, with its eligibility and custom field value intact.
    expect((await asOwnerA((tx) => getService(tx, pair.a.serviceId))).published).toBe(false);
    expect(await asOwnerA((tx) => staffServiceIds(tx, pair.a.teamMemberId))).toContain(
      pair.a.serviceId,
    );
    expect(await asOwnerA((tx) => getServiceCustomFieldValues(tx, pair.a.serviceId))).toEqual(
      new Map([['room', 'Blue']]),
    );

    await asOwnerA((tx) => setServicePublished(tx, pair.a.serviceId, true));
    expect(await publicIds()).toContain(pair.a.serviceId);
  });

  it('an edit keeps the stored published flag and mode unless the form changes them', async () => {
    const created = await asOwnerA((tx) => createService(tx, validService));
    expect(created).toMatchObject({ published: false, bookingMode: 'timed', price: '75.50' });
    await asOwnerA((tx) => setServicePublished(tx, created.id, true));
    const edited = await asOwnerA((tx) =>
      updateService(tx, created.id, { ...validService, locationType: undefined, name: 'Renamed' }),
    );
    expect(edited).toMatchObject({ name: 'Renamed', published: true, locationType: 'client_home' });
  });
});
