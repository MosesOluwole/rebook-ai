import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createService } from '@/modules/booking';
import {
  businessTypeGuard,
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  HealthClientFieldError,
} from '@/modules/crm';
import {
  type BusinessType,
  type BusinessTypeGuard,
  BusinessTypeLockedError,
  getCurrentTenant,
  HealthCustomFieldsError,
  type TenantTx,
  updateBusinessSettings,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { CHECK_VIOLATION, expectSqlState } from '../../helpers/sql-state';
import {
  actorFor,
  contextFor,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Test-engineer additions (Phase 3 decisions, item 1): health businesses hold no client-scoped
 * custom field and no un-overridden free-text field, in either direction.
 *
 * 1. The crm guard query (`businessTypeGuard.hasFieldsBarredForHealth`) is proven on its own: the
 *    integration tests in custom-fields.test.ts would stay green if it always answered false,
 *    because the trigger backstop then refuses the change with the same typed error.
 * 2. The backstop is proven on its own too: with a guard that says "nothing barred", the trigger
 *    tenants_business_type_custom_fields_lock still refuses and settings maps it to
 *    HealthCustomFieldsError.
 * 3. The trigger custom_field_definitions_health_rules refuses re-typing a structured service
 *    field to free text (an update path the existing tests do not cover).
 * 4. A first client field racing a switch to midwife never leaves a midwife business with a
 *    client field, over 20 rounds.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb({ max: 4 });
  pair = await seedTenantPair(owner, 'hdec');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

async function asOwner<T>(seed: TenantPair['a'], work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = await app.tenancy.resolveTenantForUser(seed.slug, actorFor(seed));
  return app.tenancy.withTenant(ctx, work);
}

async function changeType(seed: TenantPair['a'], to: BusinessType, guard: BusinessTypeGuard) {
  return asOwner(seed, async (tx) => {
    const tenant = await getCurrentTenant(tx);
    return updateBusinessSettings(
      tx,
      { name: tenant.name, businessType: to, timeZone: tenant.timeZone },
      guard,
    );
  });
}

async function resetTenant(seed: TenantPair['a'], type: BusinessType) {
  await owner.sql`delete from rebook.custom_field_definitions where tenant_id = ${seed.id}`;
  await owner.sql`delete from rebook.services where tenant_id = ${seed.id}`;
  await owner.sql`update rebook.tenants set business_type = ${type} where id = ${seed.id}`;
}

const barred = (seed: TenantPair['a']) =>
  asOwner(seed, (tx) => businessTypeGuard.hasFieldsBarredForHealth(tx));

/** A guard that sees nothing: only the database triggers stand in the way. */
const blindGuard: BusinessTypeGuard = {
  hasServices: () => Promise.resolve(false),
  hasFieldsBarredForHealth: () => Promise.resolve(false),
};

describe('businessTypeGuard.hasFieldsBarredForHealth', () => {
  it('is false with no fields and with structured service fields only', async () => {
    await resetTenant(pair.a, 'event_planner');
    expect(await barred(pair.a)).toBe(false);
    for (const [key, fieldType, options] of [
      ['size', 'number', []],
      ['outdoor', 'boolean', []],
      ['on_date', 'date', []],
      ['style', 'select', ['A', 'B']],
      ['extras', 'multi_select', ['A', 'B']],
    ] as const) {
      await asOwner(pair.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'service',
          key,
          label: key,
          fieldType,
          options: [...options],
        }),
      );
    }
    expect(await barred(pair.a)).toBe(false);
  });

  it('is true for any client-scoped field, structured or not, and false again once deleted', async () => {
    for (const fieldType of ['number', 'boolean', 'date', 'text']) {
      const field = await asOwner(pair.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'client',
          key: `c_${fieldType}`,
          label: 'Client',
          fieldType,
        }),
      );
      expect(await barred(pair.a), fieldType).toBe(true);
      await asOwner(pair.a, (tx) => deleteCustomFieldDefinition(tx, field.id));
      expect(await barred(pair.a), `${fieldType} deleted`).toBe(false);
    }
  });

  it('is true for an un-overridden free-text service field of either type', async () => {
    for (const fieldType of ['text', 'long_text']) {
      const field = await asOwner(pair.a, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: 'service',
          key: `s_${fieldType}`,
          label: 'Service text',
          fieldType,
        }),
      );
      expect(await barred(pair.a), fieldType).toBe(true);
      await asOwner(pair.a, (tx) => deleteCustomFieldDefinition(tx, field.id));
    }
    expect(await barred(pair.a)).toBe(false);
  });

  it('is false for a free-text service field that carries the override, and the switch then succeeds', async () => {
    // Only a health business can set the override through the application; the row is written as
    // the owner here to reach the guard's "with override" branch in a non-health business.
    await owner.sql`
      insert into rebook.custom_field_definitions
        (tenant_id, entity, key, label, field_type, health_free_text_override)
      values (${pair.a.id}, 'service', 'overridden', 'Overridden', 'long_text', true)
    `;
    expect(await barred(pair.a)).toBe(false);
    expect((await changeType(pair.a, 'midwife', businessTypeGuard)).businessType).toBe('midwife');
  });
});

describe('the database backstop for becoming a health business', () => {
  it.each([
    ['a client field', { entity: 'client', key: 'guests', label: 'Guests', fieldType: 'number' }],
    [
      'an un-overridden free-text service field',
      { entity: 'service', key: 'brief', label: 'Brief', fieldType: 'text' },
    ],
  ] as const)(
    'refuses the switch with %s even when the guard sees nothing (typed error from the trigger)',
    async (_name, field) => {
      await resetTenant(pair.b, 'other_timed');
      await asOwner(pair.b, (tx) => createCustomFieldDefinition(tx, { ...field }));
      await expect(changeType(pair.b, 'midwife', blindGuard)).rejects.toBeInstanceOf(
        HealthCustomFieldsError,
      );
      const [row] = await owner.sql<{ business_type: string }[]>`
        select business_type from rebook.tenants where id = ${pair.b.id}
      `;
      expect(row?.business_type).toBe('other_timed');
    },
  );

  it('lets a non-health to non-health change through with client and free-text fields present', async () => {
    await resetTenant(pair.b, 'other_timed');
    await asOwner(pair.b, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'client',
        key: 'notes',
        label: 'Notes',
        fieldType: 'long_text',
      }),
    );
    expect((await changeType(pair.b, 'event_planner', blindGuard)).businessType).toBe(
      'event_planner',
    );
  });

  it('reports the service lock first when services and barred fields both exist', async () => {
    await resetTenant(pair.b, 'event_planner');
    await asOwner(pair.b, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'client',
        key: 'guests',
        label: 'Guests',
        fieldType: 'number',
      }),
    );
    await asOwner(pair.b, (tx) =>
      createService(tx, {
        name: 'Planning',
        durationMinutes: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        price: '10',
        currency: 'GBP',
      }),
    );
    await expect(changeType(pair.b, 'midwife', businessTypeGuard)).rejects.toBeInstanceOf(
      BusinessTypeLockedError,
    );
  });
});

describe('custom_field_definitions_health_rules on update', () => {
  it('refuses re-typing a structured service field to free text in a health business', async () => {
    await resetTenant(pair.b, 'midwife');
    const field = await asOwner(pair.b, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'service',
        key: 'room',
        label: 'Room',
        fieldType: 'number',
      }),
    );
    for (const fieldType of ['text', 'long_text']) {
      await expectSqlState(
        app.tenancy.withTenant(contextFor(pair.b.id), (tx) =>
          tx.db.execute(
            sql`update rebook.custom_field_definitions set field_type = ${fieldType} where id = ${field.id}`,
          ),
        ),
        CHECK_VIOLATION,
      );
    }
    const [row] = await owner.sql<{ field_type: string }[]>`
      select field_type from rebook.custom_field_definitions where id = ${field.id}
    `;
    expect(row?.field_type).toBe('number');
  });
});

describe('a first client field racing a switch to midwife', () => {
  // A midwife business can never go back (Phase 2 health lock, also for the owner), so every
  // round gets a fresh event-planner tenant.
  it('never ends with a midwife business holding a client field (20 rounds)', async () => {
    const outcomes = { switched: 0, fieldFirst: 0 };
    for (let round = 0; round < 20; round += 1) {
      const race = await seedTenantPair(owner, 'hdec-race');
      try {
        await owner.sql`update rebook.tenants set business_type = 'event_planner' where id = ${race.a.id}`;
        const [change, create] = await Promise.allSettled([
          changeType(race.a, 'midwife', businessTypeGuard),
          asOwner(race.a, (tx) =>
            createCustomFieldDefinition(tx, {
              entity: 'client',
              key: 'guests',
              label: 'Guests',
              fieldType: 'number',
            }),
          ),
        ]);
        const label = `round ${String(round)}`;
        const [state] = await owner.sql<{ business_type: string; client_fields: number }[]>`
          select t.business_type,
            (select count(*)::int from rebook.custom_field_definitions d
              where d.tenant_id = t.id and d.entity = 'client') as client_fields
          from rebook.tenants t where t.id = ${race.a.id}
        `;
        if (change.status === 'fulfilled') {
          // The switch won the tenant lock; the field was then refused as a health client field.
          expect(create.status, label).toBe('rejected');
          expect(create.status === 'rejected' ? create.reason : null, label).toBeInstanceOf(
            HealthClientFieldError,
          );
          expect(state, label).toEqual({ business_type: 'midwife', client_fields: 0 });
          outcomes.switched += 1;
        } else {
          expect(change.reason, label).toBeInstanceOf(HealthCustomFieldsError);
          expect(create.status, label).toBe('fulfilled');
          expect(state, label).toEqual({ business_type: 'event_planner', client_fields: 1 });
          outcomes.fieldFirst += 1;
        }
      } finally {
        await race.cleanup();
      }
    }
    expect(outcomes.switched + outcomes.fieldFirst).toBe(20);
  });
});
