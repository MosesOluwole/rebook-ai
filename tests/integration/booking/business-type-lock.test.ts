import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createService, deleteService } from '@/modules/booking';
import { businessTypeGuard } from '@/modules/crm';
import {
  auditLogsRepository,
  BusinessTypeChangeError,
  BusinessTypeLockedError,
  type BusinessType,
  getCurrentTenant,
  updateBusinessSettings,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { CHECK_VIOLATION, expectSqlState } from '../../helpers/sql-state';
import { actorFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/**
 * Phase 3 acceptance: changing business type fails with a clear message once the tenant has any
 * service, and still works before. The Phase 2 health lock (midwife → non-health) stays.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

const guard = businessTypeGuard;
const service = {
  name: 'Consultation',
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  price: '20',
  currency: 'GBP',
};

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb({ max: 4 });
  pair = await seedTenantPair(owner, 'btlock');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

const asOwnerOf = (seed: TenantPair['a']) =>
  app.tenancy.resolveTenantForUser(seed.slug, actorFor(seed));

async function changeType(seed: TenantPair['a'], to: BusinessType) {
  return app.tenancy.withTenant(await asOwnerOf(seed), async (tx) => {
    const tenant = await getCurrentTenant(tx);
    return updateBusinessSettings(
      tx,
      { name: tenant.name, businessType: to, timeZone: tenant.timeZone },
      guard,
    );
  });
}

describe('business type lock', () => {
  it('changes freely while the tenant has no service', async () => {
    expect((await changeType(pair.a, 'event_planner')).businessType).toBe('event_planner');
    expect((await changeType(pair.a, 'other_timed')).businessType).toBe('other_timed');
  });

  it('refuses any change with a typed error and a settings message once a service exists', async () => {
    const created = await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) =>
      createService(tx, service),
    );
    const auditsBefore = await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) =>
      auditLogsRepository.listRecent(tx, 500),
    );
    const attempt = changeType(pair.a, 'event_planner');
    await expect(attempt).rejects.toBeInstanceOf(BusinessTypeLockedError);
    await expect(changeType(pair.a, 'midwife')).rejects.toThrow(
      'The business type cannot be changed once the business has services. Delete every service first if the type was chosen by mistake.',
    );
    const tenant = await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) =>
      getCurrentTenant(tx),
    );
    expect(tenant.businessType).toBe('other_timed');
    const auditsAfter = await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) =>
      auditLogsRepository.listRecent(tx, 500),
    );
    expect(auditsAfter).toHaveLength(auditsBefore.length);

    // Name and time zone still save while the type stays the same.
    const renamed = await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) =>
      updateBusinessSettings(
        tx,
        { name: 'Renamed while locked', businessType: 'other_timed', timeZone: 'Europe/Paris' },
        guard,
      ),
    );
    expect(renamed).toMatchObject({ name: 'Renamed while locked', timeZone: 'Europe/Paris' });

    // Deleting the last service lifts the lock.
    await app.tenancy.withTenant(await asOwnerOf(pair.a), (tx) => deleteService(tx, created.id));
    expect((await changeType(pair.a, 'event_planner')).businessType).toBe('event_planner');
  });

  it('is enforced by the database trigger too, even if the application guard is skipped', async () => {
    await app.tenancy.withTenant(await asOwnerOf(pair.b), (tx) => createService(tx, service));
    // A guard that lies: the trigger tenants_business_type_service_lock still refuses.
    await expect(
      app.tenancy.withTenant(await asOwnerOf(pair.b), async (tx) => {
        const tenant = await getCurrentTenant(tx);
        return updateBusinessSettings(
          tx,
          { name: tenant.name, businessType: 'event_planner', timeZone: tenant.timeZone },
          { ...businessTypeGuard, hasServices: () => Promise.resolve(false) },
        );
      }),
    ).rejects.toBeInstanceOf(BusinessTypeLockedError);
    await expectSqlState(
      app.tenancy.withTenant(await asOwnerOf(pair.b), (tx) =>
        tx.db.execute(
          sql`update rebook.tenants set business_type = 'event_planner' where id = ${pair.b.id}`,
        ),
      ),
      CHECK_VIOLATION,
    );
  });

  it('keeps the Phase 2 health lock first: a midwife with services gets the health message', async () => {
    const midwife = await seedTenantPair(owner, 'btlock-mw');
    try {
      await owner.sql`update rebook.tenants set business_type = 'midwife' where id = ${midwife.a.id}`;
      await app.tenancy.withTenant(await asOwnerOf(midwife.a), (tx) => createService(tx, service));
      await expect(changeType(midwife.a, 'other_timed')).rejects.toBeInstanceOf(
        BusinessTypeChangeError,
      );
    } finally {
      await midwife.cleanup();
    }
  });

  it('serialises a type change against a concurrent first service (no service under a stale type)', async () => {
    const race = await seedTenantPair(owner, 'btlock-race');
    try {
      for (let round = 0; round < 10; round += 1) {
        await owner.sql`delete from rebook.services where tenant_id = ${race.a.id}`;
        await owner.sql`update rebook.tenants set business_type = 'other_timed' where id = ${race.a.id}`;
        const results = await Promise.allSettled([
          changeType(race.a, 'event_planner'),
          app.tenancy.withTenant(await asOwnerOf(race.a), (tx) =>
            createService(tx, {
              name: 'Race',
              durationMinutes: 30,
              bufferBeforeMinutes: 0,
              bufferAfterMinutes: 0,
              price: '1',
              currency: 'GBP',
            }),
          ),
        ]);
        const [change, create] = results;
        expect(create.status, `round ${String(round)}`).toBe('fulfilled');
        const [state] = await owner.sql<{ business_type: string; booking_mode: string }[]>`
          select t.business_type, s.booking_mode
          from rebook.tenants t join rebook.services s on s.tenant_id = t.id
          where t.id = ${race.a.id}
        `;
        if (change.status === 'fulfilled') {
          // The change won the lock; the service was created afterwards with the new defaults.
          expect(state).toEqual({ business_type: 'event_planner', booking_mode: 'request' });
        } else {
          expect(change.reason).toBeInstanceOf(BusinessTypeLockedError);
          expect(state).toEqual({ business_type: 'other_timed', booking_mode: 'timed' });
        }
      }
    } finally {
      await race.cleanup();
    }
  });
});
