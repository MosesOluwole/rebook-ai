import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createService } from '@/modules/booking';
import {
  businessTypeGuard,
  createCustomFieldDefinition,
  HealthClientFieldError,
  deleteCustomFieldDefinition,
  getServiceCustomFieldValues,
  listCustomFieldDefinitions,
  setServiceCustomFieldValues,
} from '@/modules/crm';
import {
  auditLogsRepository,
  getCurrentTenant,
  HealthCustomFieldsError,
  updateBusinessSettings,
  PermissionDeniedError,
  type TenantTx,
  ValidationError,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { CHECK_VIOLATION, expectSqlState, FOREIGN_KEY_VIOLATION } from '../../helpers/sql-state';
import {
  actorFor,
  contextFor,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Phase 3 acceptance: a health business cannot create a free-text custom field without an
 * explicit override, and the override is audited; custom field values failing their definition's
 * type or options are rejected. Tenant A is a midwife practice, tenant B an event planner.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'cf');
  await owner.sql`update rebook.tenants set business_type = 'midwife' where id = ${pair.a.id}`;
  await owner.sql`update rebook.tenants set business_type = 'event_planner' where id = ${pair.b.id}`;
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

async function as<T>(seed: TenantPair['a'], work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = await app.tenancy.resolveTenantForUser(seed.slug, actorFor(seed));
  return app.tenancy.withTenant(ctx, work);
}

const notes = { entity: 'service', key: 'notes', label: 'Notes', fieldType: 'long_text' };

describe('health businesses and free-text fields', () => {
  it('refuses a free-text field without the override, with a field-level message', async () => {
    for (const fieldType of ['text', 'long_text']) {
      try {
        await as(pair.a, (tx) => createCustomFieldDefinition(tx, { ...notes, fieldType }));
        throw new Error('expected a ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).fieldErrors.fieldType?.[0]).toMatch(
          /free-text fields are off for health businesses/,
        );
      }
    }
    expect(await as(pair.a, (tx) => listCustomFieldDefinitions(tx))).toEqual([]);
  });

  it('refuses the override to staff (typed permission error) and records nothing', async () => {
    const staff = actorFor({ userId: pair.a.spareUserId, email: pair.a.spareEmail });
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, staff);
    await expect(
      app.tenancy.withTenant(ctx, (tx) =>
        createCustomFieldDefinition(tx, { ...notes, healthFreeTextOverride: 'on' }),
      ),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'custom_fields.health_override',
    });
    await expect(
      app.tenancy.withTenant(ctx, (tx) => createCustomFieldDefinition(tx, notes)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('accepts it with the owner override and audits the override in the same transaction', async () => {
    const definition = await as(pair.a, (tx) =>
      createCustomFieldDefinition(tx, { ...notes, healthFreeTextOverride: 'on' }),
    );
    expect(definition).toMatchObject({ fieldType: 'long_text', healthFreeTextOverride: true });

    const audit = await as(pair.a, (tx) => auditLogsRepository.listRecent(tx, 20));
    const override = audit.find(
      (row) =>
        row.action === 'custom_field.health_override_enabled' && row.entityId === definition.id,
    );
    expect(override).toMatchObject({
      actorKind: 'user',
      actorId: pair.a.userId,
      entityType: 'custom_field_definition',
      before: { healthFreeTextOverride: false },
      after: {
        healthFreeTextOverride: true,
        key: 'notes',
        fieldType: 'long_text',
        businessType: 'midwife',
      },
    });
    expect(
      audit.find((row) => row.action === 'custom_field.created' && row.entityId === definition.id),
    ).toBeDefined();
  });

  it('is refused by the database trigger without the override, whatever the application does', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.custom_field_definitions (tenant_id, entity, key, label, field_type) values (${pair.a.id}, 'service', 'raw', 'Raw', 'text')`,
        ),
      ),
      CHECK_VIOLATION,
    );
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`update rebook.custom_field_definitions set health_free_text_override = false where tenant_id = ${pair.a.id} and key = 'notes'`,
        ),
      ),
      CHECK_VIOLATION,
    );
  });

  it('lets structured service fields through for a health business, and free text for others without override', async () => {
    await as(pair.a, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'service',
        key: 'room',
        label: 'Room',
        fieldType: 'select',
        options: ['Blue', 'Green'],
      }),
    );
    const planner = await as(pair.b, (tx) => createCustomFieldDefinition(tx, notes));
    // The override flag means nothing outside health businesses and is never stored there.
    expect(planner.healthFreeTextOverride).toBe(false);
    const audit = await as(pair.b, (tx) => auditLogsRepository.listRecent(tx, 20));
    expect(audit.some((row) => row.action === 'custom_field.health_override_enabled')).toBe(false);
  });

  it('refuses every client-scoped field for a health business, of any type, with a typed error', async () => {
    for (const fieldType of ['number', 'boolean', 'date', 'text']) {
      await expect(
        as(pair.a, (tx) =>
          createCustomFieldDefinition(tx, {
            entity: 'client',
            key: `client_${fieldType}`,
            label: 'Client field',
            fieldType,
          }),
        ),
      ).rejects.toBeInstanceOf(HealthClientFieldError);
    }
    // Even with the override: it is about free text on services, not client records.
    await expect(
      as(pair.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'client',
          key: 'client_note',
          label: 'Note',
          fieldType: 'text',
          healthFreeTextOverride: 'on',
        }),
      ),
    ).rejects.toBeInstanceOf(HealthClientFieldError);
    const defined = await as(pair.a, (tx) => listCustomFieldDefinitions(tx, 'client'));
    expect(defined).toEqual([]);
  });

  it('refuses a client-scoped field for a health business in the database too', async () => {
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.custom_field_definitions (tenant_id, entity, key, label, field_type) values (${pair.a.id}, 'client', 'raw_client', 'Raw', 'number')`,
        ),
      ),
      CHECK_VIOLATION,
    );
    const [room] = await owner.sql<{ id: string }[]>`
      select id from rebook.custom_field_definitions where tenant_id = ${pair.a.id} and key = 'room'
    `;
    // Re-scoping an existing service field to clients is an update the trigger refuses as well.
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`update rebook.custom_field_definitions set entity = 'client' where id = ${room?.id ?? ''}`,
        ),
      ),
      CHECK_VIOLATION,
    );
  });

  it('refuses a duplicate key per entity with a field error', async () => {
    try {
      await as(pair.a, (tx) => createCustomFieldDefinition(tx, { ...notes, fieldType: 'number' }));
      throw new Error('expected a ValidationError');
    } catch (error) {
      expect((error as ValidationError).fieldErrors.key).toEqual([
        'already used by another field of this kind',
      ]);
    }
  });
});

describe('becoming a health business with fields the health rules forbid', () => {
  async function switchingTenant() {
    const pairX = await seedTenantPair(owner, 'cf-switch');
    await owner.sql`update rebook.tenants set business_type = 'event_planner' where id = ${pairX.a.id}`;
    const toMidwife = async () =>
      as(pairX.a, async (tx) => {
        const tenant = await getCurrentTenant(tx);
        return updateBusinessSettings(
          tx,
          { name: tenant.name, businessType: 'midwife', timeZone: tenant.timeZone },
          businessTypeGuard,
        );
      });
    const databaseRefuses = () =>
      expectSqlState(
        app.tenancy.withTenant(contextFor(pairX.a.id), (tx) =>
          tx.db.execute(
            sql`update rebook.tenants set business_type = 'midwife' where id = ${pairX.a.id}`,
          ),
        ),
        CHECK_VIOLATION,
      );
    return { pairX, toMidwife, databaseRefuses };
  }

  it('is refused while an un-overridden free-text field exists, and works once it is deleted', async () => {
    const { pairX, toMidwife, databaseRefuses } = await switchingTenant();
    try {
      const field = await as(pairX.a, (tx) =>
        createCustomFieldDefinition(tx, { ...notes, key: 'brief' }),
      );
      expect(field.healthFreeTextOverride).toBe(false);
      await expect(toMidwife()).rejects.toBeInstanceOf(HealthCustomFieldsError);
      await expect(toMidwife()).rejects.toThrow(
        'A business with client custom fields, or free-text fields without the health override, cannot become a health business. Delete those fields on the Custom fields page first.',
      );
      await databaseRefuses();
      // Structured service fields do not block it.
      await as(pairX.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'service',
          key: 'size',
          label: 'Size',
          fieldType: 'number',
        }),
      );
      await as(pairX.a, (tx) => deleteCustomFieldDefinition(tx, field.id));
      expect((await toMidwife()).businessType).toBe('midwife');
    } finally {
      await pairX.cleanup();
    }
  });

  it('is refused while any client-scoped field exists, even a structured one', async () => {
    const { pairX, toMidwife, databaseRefuses } = await switchingTenant();
    try {
      const field = await as(pairX.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'client',
          key: 'guest_count',
          label: 'Guest count',
          fieldType: 'number',
        }),
      );
      await expect(toMidwife()).rejects.toBeInstanceOf(HealthCustomFieldsError);
      await databaseRefuses();
      await as(pairX.a, (tx) => deleteCustomFieldDefinition(tx, field.id));
      expect((await toMidwife()).businessType).toBe('midwife');
    } finally {
      await pairX.cleanup();
    }
  });
});

describe('custom field values for services', () => {
  let serviceId: string;

  beforeAll(async () => {
    const service = await as(pair.b, (tx) =>
      createService(tx, {
        name: 'Wedding planning',
        durationMinutes: 480,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        price: '1500',
        currency: 'GBP',
      }),
    );
    serviceId = service.id;
    for (const definition of [
      { key: 'guests', label: 'Guests', fieldType: 'number', required: true },
      { key: 'style', label: 'Style', fieldType: 'select', options: ['Classic', 'Modern'] },
      { key: 'extras', label: 'Extras', fieldType: 'multi_select', options: ['Flowers', 'Band'] },
      { key: 'outdoor', label: 'Outdoor', fieldType: 'boolean' },
      { key: 'date_hint', label: 'Preferred date', fieldType: 'date' },
    ]) {
      await as(pair.b, (tx) =>
        createCustomFieldDefinition(tx, { entity: 'service', ...definition }),
      );
    }
  });

  it('stores values that pass their definitions, and clears blanks', async () => {
    await as(pair.b, (tx) =>
      setServiceCustomFieldValues(tx, serviceId, {
        notes: 'Bring the folder',
        guests: '120',
        style: 'Modern',
        extras: ['Flowers', 'Band'],
        outdoor: 'on',
        date_hint: '2027-06-12',
      }),
    );
    expect(await as(pair.b, (tx) => getServiceCustomFieldValues(tx, serviceId))).toEqual(
      new Map<string, unknown>([
        ['notes', 'Bring the folder'],
        ['guests', 120],
        ['style', 'Modern'],
        ['extras', ['Flowers', 'Band']],
        ['outdoor', true],
        ['date_hint', '2027-06-12'],
      ]),
    );
    // The call sets the whole set (the form posts every field): a blank optional value, and a field
    // left out, are cleared; the required field takes its new value.
    await as(pair.b, (tx) =>
      setServiceCustomFieldValues(tx, serviceId, { guests: '80', style: '', extras: [] }),
    );
    expect(await as(pair.b, (tx) => getServiceCustomFieldValues(tx, serviceId))).toEqual(
      new Map<string, unknown>([['guests', 80]]),
    );
  });

  it.each([
    [{ guests: 'many' }, 'guests'],
    [{ guests: '' }, 'guests'],
    [{ guests: '10', style: 'Rustic' }, 'style'],
    [{ guests: '10', extras: ['Flowers', 'Fireworks'] }, 'extras'],
    [{ guests: '10', outdoor: 'perhaps' }, 'outdoor'],
    [{ guests: '10', date_hint: '2027-02-30' }, 'date_hint'],
    [{ guests: '10', colour: 'red' }, 'colour'],
  ])('rejects %j on %s and stores nothing', async (input, field) => {
    const before = await as(pair.b, (tx) => getServiceCustomFieldValues(tx, serviceId));
    try {
      await as(pair.b, (tx) => setServiceCustomFieldValues(tx, serviceId, input));
      throw new Error('expected a ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fieldErrors).toHaveProperty(field);
    }
    expect(await as(pair.b, (tx) => getServiceCustomFieldValues(tx, serviceId))).toEqual(before);
  });

  it('cannot store a value against a client definition (entity in the composite key)', async () => {
    const clientField = await as(pair.b, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'client',
        key: 'vip',
        label: 'VIP',
        fieldType: 'boolean',
      }),
    );
    await expectSqlState(
      app.tenancy.withTenant(contextFor(pair.b.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.custom_field_values (tenant_id, definition_id, entity, service_id, value) values (${pair.b.id}, ${clientField.id}, 'service', ${serviceId}, 'true'::jsonb)`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('deleting a definition removes its values and is audited', async () => {
    const [style] = (await as(pair.b, (tx) => listCustomFieldDefinitions(tx, 'service'))).filter(
      (d) => d.key === 'style',
    );
    if (style === undefined) {
      throw new Error('fixture: style definition');
    }
    await as(pair.b, (tx) => deleteCustomFieldDefinition(tx, style.id));
    expect(
      (await as(pair.b, (tx) => getServiceCustomFieldValues(tx, serviceId))).has('style'),
    ).toBe(false);
    const audit = await as(pair.b, (tx) => auditLogsRepository.listRecent(tx, 20));
    expect(
      audit.find((row) => row.action === 'custom_field.deleted' && row.entityId === style.id),
    ).toMatchObject({ before: { key: 'style', fieldType: 'select' } });
  });
});
