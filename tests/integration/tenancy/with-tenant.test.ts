import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLogsRepository,
  isFeatureEnabled,
  locationsRepository,
  membershipsRepository,
  NestedTenantTransactionError,
  setFeatureFlag,
  TenantContextError,
  tenantsRepository,
  ValidationError,
} from '@/modules/tenancy';
import { isUuidV7 } from '@/shared/kernel/uuid-v7';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { expectSqlState, UNIQUE_VIOLATION } from '../../helpers/sql-state';
import {
  contextFor,
  removeTenants,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * withTenant behaviour: role switch, context settings, validation, rollback, and the pooled
 * connection case (docs/phases.md Phase 1), plus the createTenant path that depends on them.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'ctx');
});

afterAll(async () => {
  await removeTenants(owner, createdTenantIds);
  await pair.cleanup();
  await app.close();
  await owner.close();
});

type SessionState = Record<'role' | 'tenant' | 'actor' | 'kind' | 'request', string>;

const sessionState = sql`
  select current_user::text as role,
         current_setting('app.tenant_id', true) as tenant,
         current_setting('app.actor_id', true) as actor,
         current_setting('app.actor_kind', true) as kind,
         current_setting('app.request_id', true) as request
`;

describe('withTenant', () => {
  it('runs as rebook_app with every context setting installed', async () => {
    const ctx = contextFor(pair.a.id, { requestId: 'req-42' });
    const [state] = await app.tenancy.withTenant(ctx, (tx) =>
      tx.db.execute<SessionState>(sessionState),
    );
    expect(state).toEqual({
      role: 'rebook_app',
      tenant: pair.a.id,
      actor: ctx.actorId,
      kind: 'user',
      request: 'req-42',
    });
  });

  it('withWorkerTenant runs as rebook_worker and stores an absent actor as empty', async () => {
    const ctx = contextFor(pair.a.id, { actorKind: 'worker', actorId: null });
    const [state] = await app.tenancy.withWorkerTenant(ctx, (tx) =>
      tx.db.execute<SessionState>(sessionState),
    );
    expect(state?.role).toBe('rebook_worker');
    expect(state?.actor).toBe('');
    expect(state?.kind).toBe('worker');
  });

  it('exposes the validated context and role on the handle', async () => {
    const ctx = contextFor(pair.a.id);
    const seen = await app.tenancy.withTenant(ctx, (tx) =>
      Promise.resolve({ ctx: tx.ctx, role: tx.role }),
    );
    expect(seen).toEqual({ ctx, role: 'rebook_app' });
  });

  it('rejects an invalid context before opening a transaction', async () => {
    await expect(
      app.tenancy.withTenant(
        { tenantId: 'not-a-uuid', actorKind: 'user', actorId: null, requestId: 'r' },
        () => Promise.resolve('ran'),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      app.tenancy.withTenant(
        { tenantId: pair.a.id, actorKind: 'user', actorId: null, requestId: 'r' },
        () => Promise.resolve('ran'),
      ),
    ).rejects.toThrow(/actorId is required when actorKind is 'user'/);
  });

  it('rolls everything back when the work throws', async () => {
    const marker = `rollback-${randomUUID()}`;
    await expect(
      app.tenancy.withTenant(contextFor(pair.a.id), async (tx) => {
        await locationsRepository.insert(tx, { name: marker, timeZone: 'Europe/London' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const names = await app.tenancy.withTenant(contextFor(pair.a.id), async (tx) =>
      (await locationsRepository.list(tx)).map((location) => location.name),
    );
    expect(names).not.toContain(marker);
  });

  it('refuses to nest and rolls the outer transaction back', async () => {
    const marker = `nested-${randomUUID()}`;
    await expect(
      app.tenancy.withTenant(contextFor(pair.a.id), async (outer) => {
        await locationsRepository.insert(outer, { name: marker, timeZone: 'Europe/London' });
        return app.tenancy.withTenant(contextFor(pair.a.id), () => Promise.resolve('inner ran'));
      }),
    ).rejects.toBeInstanceOf(NestedTenantTransactionError);
    const names = await app.tenancy.withTenant(contextFor(pair.a.id), async (tx) =>
      (await locationsRepository.list(tx)).map((location) => location.name),
    );
    expect(names).not.toContain(marker);
  });

  it('leaves the connection as rebook_authenticator with no context afterwards', async () => {
    await app.tenancy.withTenant(contextFor(pair.a.id), () => Promise.resolve());
    const [state] = await app.client.sql<{ role: string; tenant: string | null }[]>`
      select current_user::text as role, current_setting('app.tenant_id', true) as tenant
    `;
    expect(state?.role).toBe('rebook_authenticator');
    expect(state?.tenant ?? '').toBe('');
  });
});

describe('one pooled connection', () => {
  it('a transaction with no context after one with tenant A sees zero rows and raises no error', async () => {
    const single = await connectAppDb({ max: 1 });
    try {
      const seenAsA = await single.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
      );
      expect(seenAsA.map((row) => row.id)).toEqual([pair.a.id]);

      const [after] = await single.client.sql.begin(async (tx) => {
        await tx`set local role rebook_app`;
        return tx<{ raw_setting: string; tenants: number; locations: number }[]>`
          select current_setting('app.tenant_id', true) as raw_setting,
                 (select count(*) from rebook.tenants)::int as tenants,
                 (select count(*) from rebook.locations)::int as locations
        `;
      });
      // The setting survives as an empty string on the reused connection; nullif turns it into
      // NULL inside the policies, which is why this is zero rows rather than an error.
      expect(after?.raw_setting).toBe('');
      expect(after?.tenants).toBe(0);
      expect(after?.locations).toBe(0);

      const seenAsB = await single.tenancy.withTenant(contextFor(pair.b.id), (tx) =>
        tx.db.execute<{ id: string }>(sql`select id from rebook.tenants`),
      );
      expect(seenAsB.map((row) => row.id)).toEqual([pair.b.id]);
    } finally {
      await single.close();
    }
  });
});

describe('createTenant', () => {
  const caller = {
    actorKind: 'system' as const,
    actorId: null,
    requestId: `create-${randomUUID()}`,
  };

  it('generates a UUIDv7 id, inserts inside its own context and writes the first audit entry', async () => {
    const slug = `created-${randomUUID().slice(0, 8)}`;
    const tenant = await app.tenancy.createTenant(
      { name: '  New Practice ', slug, timeZone: 'Europe/London' },
      caller,
    );
    createdTenantIds.push(tenant.id);

    expect(isUuidV7(tenant.id)).toBe(true);
    expect(tenant.name).toBe('New Practice');

    const seen = await app.tenancy.withTenant(contextFor(tenant.id), async (tx) => ({
      tenant: await tenantsRepository.findCurrent(tx),
      audit: await auditLogsRepository.listRecent(tx),
    }));
    expect(seen.tenant?.slug).toBe(slug);
    expect(seen.audit).toHaveLength(1);
    expect(seen.audit[0]).toMatchObject({
      action: 'tenant.created',
      entityType: 'tenant',
      entityId: tenant.id,
      actorKind: 'system',
      actorId: null,
      requestId: caller.requestId,
      after: { name: 'New Practice', slug, timeZone: 'Europe/London' },
    });
  });

  it('rejects invalid input before touching the database', async () => {
    await expect(
      app.tenancy.createTenant({ name: 'X', slug: 'Bad Slug', timeZone: 'Europe/London' }, caller),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('surfaces a duplicate slug as a unique violation', async () => {
    await expectSqlState(
      app.tenancy.createTenant(
        { name: 'Dup', slug: pair.a.slug, timeZone: 'Europe/London' },
        caller,
      ),
      UNIQUE_VIOLATION,
    );
  });
});

describe('feature flags', () => {
  it('toggles a flag and audits before and after in the same transaction', async () => {
    const flag = `probe_flag_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const ctx = contextFor(pair.a.id);

    const first = await app.tenancy.withTenant(ctx, (tx) => setFeatureFlag(tx, flag, true));
    expect(first).toEqual({ before: null, after: true });

    const second = await app.tenancy.withTenant(ctx, (tx) => setFeatureFlag(tx, flag, false));
    expect(second).toEqual({ before: true, after: false });

    const state = await app.tenancy.withTenant(ctx, async (tx) => ({
      enabled: await isFeatureEnabled(tx, flag),
      audit: (await auditLogsRepository.listRecent(tx)).filter(
        (entry) =>
          entry.action === 'feature_flag.updated' &&
          (entry.after as { flag: string }).flag === flag,
      ),
    }));
    expect(state.enabled).toBe(false);
    expect(state.audit).toHaveLength(2);
    expect(state.audit.map((entry) => [entry.before, entry.after])).toEqual([
      [
        { flag, enabled: true },
        { flag, enabled: false },
      ],
      [null, { flag, enabled: true }],
    ]);
    expect(
      state.audit.every(
        (entry) => entry.actorId === ctx.actorId && entry.requestId === ctx.requestId,
      ),
    ).toBe(true);
  });

  it('rejects a malformed flag name before touching the database', async () => {
    await expect(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) => setFeatureFlag(tx, 'Bad Flag', true)),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('tenant_memberships visibility by user', () => {
  it('lets a user see their memberships across tenants, and nothing for another user', async () => {
    // Owner-only arrangement: give tenant A's user a second membership in tenant B.
    await owner.sql`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.b.id}, ${pair.a.userId}, 'staff')
    `;

    const mine = await app.tenancy.withTenant(
      contextFor(pair.a.id, { actorId: pair.a.userId }),
      (tx) => membershipsRepository.listForCurrentActor(tx),
    );
    expect(mine.map((membership) => membership.tenantId).sort()).toEqual(
      [pair.a.id, pair.b.id].sort(),
    );

    const someoneElse = await app.tenancy.withTenant(
      contextFor(pair.a.id, { actorId: randomUUID() }),
      (tx) => membershipsRepository.listForCurrentActor(tx),
    );
    expect(someoneElse).toEqual([]);

    const anonymous = await app.tenancy.withTenant(
      contextFor(pair.a.id, { actorKind: 'anonymous', actorId: null }),
      (tx) => membershipsRepository.listForCurrentActor(tx),
    );
    expect(anonymous).toEqual([]);
  });

  it('still hides tenant B memberships of other users from tenant A', async () => {
    const rows = await app.tenancy.withTenant(
      contextFor(pair.a.id, { actorId: pair.a.userId }),
      (tx) =>
        tx.db.execute<{ tenant_id: string; user_id: string }>(
          sql`select tenant_id, user_id from rebook.tenant_memberships`,
        ),
    );
    expect(rows.every((row) => row.tenant_id === pair.a.id || row.user_id === pair.a.userId)).toBe(
      true,
    );
    expect(rows.some((row) => row.user_id === pair.b.userId)).toBe(false);
  });
});
