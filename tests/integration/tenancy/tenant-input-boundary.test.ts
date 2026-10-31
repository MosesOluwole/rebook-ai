import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalTimeZone, ValidationError } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { sqlState } from '../../helpers/sql-state';
import {
  actorFor,
  createAuthUser,
  type FixtureUser,
  removeAuthUsers,
  removeTenants,
} from '../../helpers/tenant-fixtures';

/**
 * CLAUDE.md: "Validation: Zod at every boundary" and "Errors: typed, never swallowed". The time
 * zone rule (docs/adr/ADR-003-time-zones.md) and the database CHECK (rebook.is_time_zone) must
 * agree: everything the rule accepts is stored in a form the database accepts, and everything
 * the rule rejects fails as a typed ValidationError before any transaction opens. Phase 2
 * acceptance criterion: wrong-case and alias time zones follow the documented rule and are never
 * stored as typed.
 */

let owner: DbClient;
let app: AppDb;
let user: FixtureUser;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  app = await connectAppDb();
  user = await createAuthUser(owner, 'tz');
});

afterAll(async () => {
  await removeTenants(owner, createdTenantIds);
  await removeAuthUsers(owner, [user.id]);
  await app.close();
  await owner.close();
});

async function onboard(timeZone: string) {
  const tenant = await app.tenancy.completeOnboarding(
    { name: `Zone Probe ${randomUUID().slice(0, 6)}`, businessType: 'other_timed', timeZone },
    actorFor(user),
  );
  createdTenantIds.push(tenant.id);
  return tenant;
}

describe('onboarding stores the canonical time zone, never the typed one', () => {
  it.each([
    ['europe/london', 'Europe/London'],
    ['EUROPE/LONDON', 'Europe/London'],
    ['America/New_york', 'America/New_York'],
    ['GB', 'Europe/London'],
    ['US/Eastern', 'America/New_York'],
    ['utc', 'UTC'],
    ['Etc/UTC', 'UTC'],
  ])('stores %s as %s on the tenant and its default location', async (typed, stored) => {
    const tenant = await onboard(typed);
    expect(tenant.timeZone).toBe(stored);
    const [row] = await owner.sql<{ tenant_tz: string; location_tz: string }[]>`
      select t.time_zone as tenant_tz, l.time_zone as location_tz
      from rebook.tenants t join rebook.locations l on l.tenant_id = t.id
      where t.id = ${tenant.id}
    `;
    expect(row).toEqual({ tenant_tz: stored, location_tz: stored });
  });

  it.each(['EST', 'CET', 'Etc/GMT+1', 'Mars/Olympus', '', 'London'])(
    'rejects %s with a typed ValidationError, not a CHECK violation',
    async (timeZone) => {
      let caught: unknown;
      try {
        await onboard(timeZone);
      } catch (error) {
        caught = error;
      }
      // A raw SQLSTATE 23514 would mean the rule let through a value the database refuses.
      expect(sqlState(caught), 'database constraint reached').toBeUndefined();
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as Error).message).toMatch(/timeZone: must be an IANA time zone name/);
    },
  );
});

describe('the set of time zones the app stores is a subset of what the database accepts', () => {
  it('rebook.is_time_zone() is true for the stored form of every Intl-supported zone and every alias the rule converts', async () => {
    const inputs = [
      ...Intl.supportedValuesOf('timeZone'),
      'GB',
      'US/Eastern',
      'Japan',
      'Europe/Kyiv',
      'Asia/Kolkata',
      'utc',
      'Etc/GMT',
    ];
    const stored = [...new Set(inputs.map(canonicalTimeZone))].filter(
      (zone): zone is string => zone !== null,
    );
    expect(stored.length).toBeGreaterThan(300);

    const rows = await app.client.sql.begin(async (tx) => {
      await tx`set local role rebook_app`;
      return tx<{ zone: string; ok: boolean }[]>`
        select z as zone, rebook.is_time_zone(z) as ok from unnest(${stored}::text[]) as z
      `;
    });
    expect(rows).toHaveLength(stored.length);
    expect(rows.filter((row) => !row.ok).map((row) => row.zone)).toEqual([]);
  });
});
