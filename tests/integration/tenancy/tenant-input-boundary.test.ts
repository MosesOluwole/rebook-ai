import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isIanaTimeZone, ValidationError } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { sqlState } from '../../helpers/sql-state';
import { removeTenants } from '../../helpers/tenant-fixtures';

/**
 * CLAUDE.md: "Validation: Zod at every boundary" and "Errors: typed, never swallowed". The
 * tenant input schema (src/modules/tenancy/domain/tenant.ts) and the database CHECK
 * (rebook.is_time_zone, migration part 1) must agree, otherwise a value that passes the module
 * boundary dies inside the transaction as a raw constraint violation the caller cannot map to a
 * field error. Intl.DateTimeFormat accepts time zone names case-insensitively; pg_timezone_names
 * is case-sensitive, so the two disagree on non-canonical spellings.
 */

let owner: DbClient;
let app: AppDb;
const createdTenantIds: string[] = [];

const caller = { actorKind: 'system' as const, actorId: null, requestId: `tz-${randomUUID()}` };

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  app = await connectAppDb();
});

afterAll(async () => {
  await removeTenants(owner, createdTenantIds);
  await app.close();
  await owner.close();
});

describe('createTenant time zone validation agrees with the database constraint', () => {
  it.each(['europe/london', 'EUROPE/LONDON', 'utc'])(
    'rejects the non-canonical spelling %s with a typed ValidationError, not a CHECK violation',
    async (timeZone) => {
      const slug = `tz-${randomUUID().slice(0, 8)}`;
      let caught: unknown;
      try {
        const tenant = await app.tenancy.createTenant(
          { name: 'Zone Probe', slug, timeZone },
          caller,
        );
        createdTenantIds.push(tenant.id);
      } catch (error) {
        caught = error;
      }
      // Either outcome below is acceptable only if it is the typed error: a raw SQLSTATE 23514
      // means the Zod schema let through a value the database refuses.
      expect(sqlState(caught), 'database constraint reached').toBeUndefined();
      expect(caught).toBeInstanceOf(ValidationError);
    },
  );

  it('accepts the canonical spelling Europe/London', async () => {
    const slug = `tz-${randomUUID().slice(0, 8)}`;
    const tenant = await app.tenancy.createTenant(
      { name: 'Zone Probe', slug, timeZone: 'Europe/London' },
      caller,
    );
    createdTenantIds.push(tenant.id);
    expect(tenant.timeZone).toBe('Europe/London');
  });
});

describe('the set of time zones the app accepts is a subset of what the database accepts', () => {
  it('rebook.is_time_zone() returns true for every Intl-supported zone that passes isIanaTimeZone', async () => {
    const appAccepted = Intl.supportedValuesOf('timeZone').filter(isIanaTimeZone);
    expect(appAccepted.length).toBeGreaterThan(300);

    const rows = await app.client.sql.begin(async (tx) => {
      await tx`set local role rebook_app`;
      return tx<{ zone: string; ok: boolean }[]>`
        select z as zone, rebook.is_time_zone(z) as ok from unnest(${appAccepted}::text[]) as z
      `;
    });
    const rejectedByDatabase = rows.filter((row) => !row.ok).map((row) => row.zone);
    expect(rows).toHaveLength(appAccepted.length);
    expect(rejectedByDatabase).toEqual([]);
  });
});
