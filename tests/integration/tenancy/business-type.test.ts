import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { businessTypeGuard } from '@/modules/crm';
import {
  auditLogsRepository,
  BusinessTypeChangeError,
  type BusinessType,
  getCurrentTenant,
  tenantsRepository,
  updateBusinessSettings,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { CHECK_VIOLATION, sqlState } from '../../helpers/sql-state';
import {
  actorFor,
  contextFor,
  removeTenants,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Business type changes (Phase 2 follow-up): a midwife business can never become a non-health
 * business, every other direction is allowed and audited. The application refuses with a typed
 * error before touching the row; the trigger `tenants_business_type_health_lock` is the backstop
 * for anything that reaches the table directly.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'bt');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

async function change(to: BusinessType) {
  const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
  return app.tenancy.withTenant(ctx, (tx) =>
    updateBusinessSettings(
      tx,
      { name: pair.a.name, businessType: to, timeZone: 'Europe/London' },
      businessTypeGuard,
    ),
  );
}

async function current(): Promise<{ businessType: BusinessType; audits: number }> {
  const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
  return app.tenancy.withTenant(ctx, async (tx) => ({
    businessType: (await getCurrentTenant(tx)).businessType,
    audits: (await auditLogsRepository.listRecent(tx, 500)).filter(
      (row) => row.action === 'tenant.updated',
    ).length,
  }));
}

describe('business type transitions through updateBusinessSettings', () => {
  it('allows every change between and towards non-health types, and into midwife', async () => {
    // Seeded as other_timed.
    expect((await change('event_planner')).businessType).toBe('event_planner');
    expect((await change('other_timed')).businessType).toBe('other_timed');
    expect((await change('event_planner')).businessType).toBe('event_planner');
    expect((await change('midwife')).businessType).toBe('midwife');
    expect((await change('midwife')).businessType).toBe('midwife');
    const state = await current();
    expect(state.businessType).toBe('midwife');
    expect(state.audits).toBe(5);
  });

  it.each(['event_planner', 'other_timed'] as const)(
    'refuses midwife → %s with a typed error, leaves the type and the audit log untouched',
    async (to) => {
      const before = await current();
      expect(before.businessType).toBe('midwife');
      await expect(change(to)).rejects.toBeInstanceOf(BusinessTypeChangeError);
      await expect(change(to)).rejects.toThrow(/midwife business cannot be changed/);
      const after = await current();
      expect(after).toEqual(before);
    },
  );

  it('is enforced by the database trigger for a direct update as the runtime role', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    let caught: unknown;
    try {
      await app.tenancy.withTenant(ctx, (tx) =>
        tx.db.execute(
          sql`update rebook.tenants set business_type = 'other_timed' where id = ${pair.a.id}`,
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(sqlState(caught)).toBe(CHECK_VIOLATION);
    expect((caught as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      'tenants_business_type_health_lock',
    );
    expect((await current()).businessType).toBe('midwife');
  });
});

// ---- Follow-up verification (test engineer): every direction, application and trigger ------

const DIRECTIONS = [
  ['midwife', 'event_planner', false],
  ['midwife', 'other_timed', false],
  ['midwife', 'midwife', true],
  ['event_planner', 'midwife', true],
  ['other_timed', 'midwife', true],
  ['event_planner', 'other_timed', true],
  ['other_timed', 'event_planner', true],
  ['event_planner', 'event_planner', true],
  ['other_timed', 'other_timed', true],
] as const;

function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const name = (current as { constraint_name?: unknown }).constraint_name;
    if (typeof name === 'string') {
      return name;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe('business type directions, each on a fresh tenant', () => {
  // Owner-only arrangement: a new tenant per case in the starting type, with tenant B's owner as
  // its owner so the application path has a user with settings.update. The trigger fires for the
  // owner too, so a midwife tenant could not be put back; a fresh row per case avoids that.
  const extra: string[] = [];
  afterAll(async () => {
    await removeTenants(owner, extra);
  });
  async function freshTenant(from: BusinessType) {
    const slug = `bt-dir-${randomUUID().slice(0, 8)}`;
    const name = `Direction ${slug}`;
    const [row] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenants (name, slug, business_type, time_zone)
      values (${name}, ${slug}, ${from}, 'Europe/London') returning id
    `;
    if (row === undefined) {
      throw new Error('fixture: tenant insert returned no row');
    }
    await owner.sql`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${row.id}, ${pair.b.userId}, 'owner')
    `;
    extra.push(row.id);
    return { id: row.id, slug, name };
  }
  async function stateOf(id: string): Promise<{ businessType: BusinessType; audits: number }> {
    return app.tenancy.withTenant(contextFor(id), async (tx) => {
      const tenant = await tenantsRepository.findCurrent(tx);
      if (tenant === null) {
        throw new Error('fixture tenant not visible in its own context');
      }
      return {
        businessType: tenant.businessType,
        audits: (await auditLogsRepository.listRecent(tx, 500)).filter(
          (row) => row.action === 'tenant.updated',
        ).length,
      };
    });
  }

  it.each(DIRECTIONS)(
    'updateBusinessSettings %s → %s (allowed: %s): typed error or one audit row',
    async (from, to, allowed) => {
      const tenant = await freshTenant(from);
      const before = await stateOf(tenant.id);
      expect(before).toEqual({ businessType: from, audits: 0 });
      const ctx = await app.tenancy.resolveTenantForUser(tenant.slug, actorFor(pair.b));
      const attempt = app.tenancy.withTenant(ctx, (tx) =>
        updateBusinessSettings(
          tx,
          { name: tenant.name, businessType: to, timeZone: 'Europe/London' },
          businessTypeGuard,
        ),
      );
      if (allowed) {
        expect((await attempt).businessType).toBe(to);
        expect(await stateOf(tenant.id)).toEqual({ businessType: to, audits: 1 });
        const audit = await app.tenancy.withTenant(contextFor(tenant.id), (tx) =>
          auditLogsRepository.listRecent(tx, 5),
        );
        expect(audit.find((row) => row.action === 'tenant.updated')).toMatchObject({
          before: { businessType: from },
          after: { businessType: to },
        });
      } else {
        const error = await attempt.then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(BusinessTypeChangeError);
        expect(error).toMatchObject({
          kind: 'BusinessTypeChangeError',
          message: expect.stringMatching(/midwife business cannot be changed/) as unknown,
        });
        expect(await stateOf(tenant.id)).toEqual(before);
      }
    },
  );

  it.each(DIRECTIONS)(
    'trigger: a direct update %s → %s as rebook_app (allowed: %s)',
    async (from, to, allowed) => {
      const tenant = await freshTenant(from);
      const attempt = app.tenancy.withTenant(contextFor(tenant.id), (tx) =>
        tx.db.execute(sql`update rebook.tenants set business_type = ${to} where id = ${tenant.id}`),
      );
      if (allowed) {
        await attempt;
        expect((await stateOf(tenant.id)).businessType).toBe(to);
      } else {
        const error = await attempt.then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(sqlState(error)).toBe(CHECK_VIOLATION);
        expect(constraintOf(error)).toBe('tenants_business_type_health_lock');
        expect((await stateOf(tenant.id)).businessType).toBe(from);
      }
    },
  );

  it('the trigger fires only on business_type changes: other updates on a midwife tenant pass', async () => {
    const tenant = await freshTenant('midwife');
    await app.tenancy.withTenant(contextFor(tenant.id), (tx) =>
      tx.db.execute(sql`update rebook.tenants set name = ${tenant.name} where id = ${tenant.id}`),
    );
    expect((await stateOf(tenant.id)).businessType).toBe('midwife');
  });
});
