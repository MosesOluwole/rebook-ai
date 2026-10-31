import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createService, tenantHasServices } from '@/modules/booking';
import {
  businessTypeGuard,
  createCustomFieldDefinition,
  getServiceCustomFieldValues,
  setServiceCustomFieldValues,
} from '@/modules/crm';
import { getCurrentTenant, type TenantTx, updateBusinessSettings } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { actorFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/**
 * Test-engineer additions (Phase 3).
 *
 * 1. "A health business cannot create a free-text custom field without an explicit override, and
 *    the override is audited." The invariant behind it is that a health business never holds a
 *    free-text definition without an audited override. The creation path and the trigger on
 *    custom_field_definitions enforce it; this checks the other way in: a non-health business
 *    defines a free-text field (legitimately, no override) and then switches to midwife while it
 *    still has no services (the type change is allowed then). Either the change must be refused,
 *    or no free-text definition without the override may be left in the now-health business.
 *
 * 2. custom-fields.test.ts "stores values that pass their definitions, and clears blanks" never
 *    asserts the clearing (its second call is `.catch(() => undefined)`); this proves it.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'cfinv');
  await owner.sql`update rebook.tenants set business_type = 'event_planner' where id = ${pair.a.id}`;
  await owner.sql`update rebook.tenants set business_type = 'event_planner' where id = ${pair.b.id}`;
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

describe('a health business never holds a free-text field without the override', () => {
  it('switching a business with an un-overridden free-text field to midwife is refused or leaves none behind', async () => {
    await asOwner(pair.a, (tx) =>
      createCustomFieldDefinition(tx, {
        entity: 'client',
        key: 'notes',
        label: 'Notes',
        fieldType: 'long_text',
      }),
    );
    expect(await asOwner(pair.a, (tx) => tenantHasServices(tx))).toBe(false);

    // The attempt may legitimately be refused; what must never happen is the end state below.
    await asOwner(pair.a, async (tx) => {
      const tenant = await getCurrentTenant(tx);
      return updateBusinessSettings(
        tx,
        { name: tenant.name, businessType: 'midwife', timeZone: tenant.timeZone },
        businessTypeGuard,
      );
    }).catch((error: unknown) => error);

    const offending = await owner.sql<{ key: string }[]>`
      select d.key from rebook.custom_field_definitions d
      join rebook.tenants t on t.id = d.tenant_id
      where t.id = ${pair.a.id}
        and t.business_type = 'midwife'
        and d.field_type in ('text', 'long_text')
        and not d.health_free_text_override
    `;
    expect(offending.map((row) => row.key)).toEqual([]);
  });
});

describe('custom field values: a blank optional value clears the stored value', () => {
  it('clears a select and a multi-select left blank and keeps the rest', async () => {
    const service = await asOwner(pair.b, (tx) =>
      createService(tx, {
        name: 'Clearing probe',
        durationMinutes: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        price: '1',
        currency: 'GBP',
      }),
    );
    for (const definition of [
      { key: 'guests', label: 'Guests', fieldType: 'number', required: true },
      { key: 'style', label: 'Style', fieldType: 'select', options: ['Classic', 'Modern'] },
      { key: 'extras', label: 'Extras', fieldType: 'multi_select', options: ['Flowers', 'Band'] },
    ]) {
      await asOwner(pair.b, (tx) =>
        createCustomFieldDefinition(tx, { entity: 'service', ...definition }),
      );
    }
    await asOwner(pair.b, (tx) =>
      setServiceCustomFieldValues(tx, service.id, {
        guests: '120',
        style: 'Modern',
        extras: ['Flowers'],
      }),
    );
    await asOwner(pair.b, (tx) =>
      setServiceCustomFieldValues(tx, service.id, { guests: '80', style: '', extras: [] }),
    );
    expect(await asOwner(pair.b, (tx) => getServiceCustomFieldValues(tx, service.id))).toEqual(
      new Map<string, unknown>([['guests', 80]]),
    );
  });
});
