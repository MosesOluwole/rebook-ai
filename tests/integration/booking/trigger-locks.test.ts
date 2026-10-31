import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { CHECK_VIOLATION, expectSqlState } from '../../helpers/sql-state';
import { contextFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/**
 * Review finding N1 (Phase 3 decisions): the business-type rules must hold in the database even
 * for a writer that never takes the application's tenant-row lock. The triggers share-lock the
 * tenant row themselves (services_lock_tenant, custom_field_definitions_health_rules), so a type
 * change and a new service or field serialise. Each test holds one transaction open, shows the
 * other waits, then commits and expects the waiting one to see the committed state.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb({ max: 4 });
  pair = await seedTenantPair(owner, 'trglock');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

/** A deferred: a promise plus its resolver, to hold a transaction open on purpose. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function setType(tenantId: string, type: string) {
  await owner.sql`update rebook.tenants set business_type = ${type} where id = ${tenantId}`;
}

describe('triggers lock the tenant row themselves', () => {
  it('a raw service insert in flight makes a business type change wait, then refuse', async () => {
    const tenantId = pair.a.id;
    await owner.sql`delete from rebook.services where tenant_id = ${tenantId}`;
    await setType(tenantId, 'other_timed');

    const inserted = gate();
    const release = gate();
    const insert = app.tenancy.withTenant(contextFor(tenantId), async (tx) => {
      await tx.db.execute(
        sql`insert into rebook.services (tenant_id, name, booking_mode, duration_minutes, price, currency, location_type) values (${tenantId}, 'Raw', 'timed', 30, 1, 'GBP', 'clinic')`,
      );
      inserted.open();
      await release.wait;
    });
    await inserted.wait;

    let changeSettled = false;
    const change = app.tenancy
      .withTenant(contextFor(tenantId), (tx) =>
        tx.db.execute(
          sql`update rebook.tenants set business_type = 'event_planner' where id = ${tenantId}`,
        ),
      )
      .finally(() => {
        changeSettled = true;
      });
    await pause(300);
    expect(changeSettled, 'the type change waits for the service insert').toBe(false);

    release.open();
    await insert;
    await expectSqlState(change, CHECK_VIOLATION);
    const [row] = await owner.sql<{ business_type: string }[]>`
      select business_type from rebook.tenants where id = ${tenantId}
    `;
    expect(row?.business_type).toBe('other_timed');
  });

  it('a raw switch to midwife in flight makes a client field insert wait, then refuse', async () => {
    const tenantId = pair.b.id;
    await owner.sql`delete from rebook.custom_field_definitions where tenant_id = ${tenantId}`;
    await setType(tenantId, 'event_planner');

    const changed = gate();
    const release = gate();
    const change = app.tenancy.withTenant(contextFor(tenantId), async (tx) => {
      await tx.db.execute(
        sql`update rebook.tenants set business_type = 'midwife' where id = ${tenantId}`,
      );
      changed.open();
      await release.wait;
    });
    await changed.wait;

    let insertSettled = false;
    const insert = app.tenancy
      .withTenant(contextFor(tenantId), (tx) =>
        tx.db.execute(
          sql`insert into rebook.custom_field_definitions (tenant_id, entity, key, label, field_type) values (${tenantId}, 'client', 'guests', 'Guests', 'number')`,
        ),
      )
      .finally(() => {
        insertSettled = true;
      });
    await pause(300);
    expect(insertSettled, 'the field insert waits for the type change').toBe(false);

    release.open();
    await change;
    await expectSqlState(insert, CHECK_VIOLATION);
    const [row] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.custom_field_definitions where tenant_id = ${tenantId}
    `;
    expect(row?.n).toBe(0);
  });
});
