import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLogsRepository,
  isFeatureEnabled,
  locationsRepository,
  NestedTenantTransactionError,
  PermissionDeniedError,
  requireFlag,
  FeatureDisabledError,
  TenantContextError,
  toggleFeatureFlag,
  updateBusinessSettings,
  ValidationError,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { sqlState, UNIQUE_VIOLATION } from '../../helpers/sql-state';
import {
  actorFor,
  contextFor,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * withTenant and withUserContext behaviour: role switch, context settings, validation, rollback,
 * the pooled connection case (docs/phases.md Phase 1), the nesting guard, and the audited feature
 * flag toggle (Phase 2 acceptance criterion).
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'ctx');
});

afterAll(async () => {
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
      actor: '',
      kind: 'system',
      request: 'req-42',
    });
  });

  it('installs the user as actor for an authorised context', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    const [state] = await app.tenancy.withTenant(ctx, (tx) =>
      tx.db.execute<SessionState>(sessionState),
    );
    expect(state).toMatchObject({
      role: 'rebook_app',
      tenant: pair.a.id,
      actor: pair.a.userId,
      kind: 'user',
    });
    expect(ctx.role).toBe('owner');
    expect(ctx.grant).toBe('membership');
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

  it('exposes the validated settings, the original context and the role on the handle', async () => {
    const ctx = contextFor(pair.a.id);
    const seen = await app.tenancy.withTenant(ctx, (tx) =>
      Promise.resolve({ ctx: tx.ctx, context: tx.context, role: tx.role }),
    );
    expect(seen).toEqual({ ctx, context: ctx, role: 'rebook_app' });
  });

  it('rejects an invalid context before opening a transaction', async () => {
    await expect(
      app.tenancy.withTenant(
        { tenantId: 'not-a-uuid', actorKind: 'system', actorId: null, requestId: 'r' },
        () => Promise.resolve('ran'),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      app.tenancy.withTenant(
        { tenantId: pair.a.id, actorKind: 'customer', actorId: null, requestId: 'r' },
        () => Promise.resolve('ran'),
      ),
    ).rejects.toThrow(/actorId is required when actorKind is 'customer'/);
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
    await expect(
      app.tenancy.withUserContext(actorFor(pair.a), () =>
        app.tenancy.withTenant(contextFor(pair.a.id), () => Promise.resolve('inner ran')),
      ),
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

describe('withUserContext', () => {
  it('runs as rebook_app with the actor installed and an empty tenant', async () => {
    const actor = actorFor(pair.a, { requestId: 'user-req-7' });
    const [state] = await app.tenancy.withUserContext(actor, (tx) =>
      tx.db.execute<SessionState>(sessionState),
    );
    expect(state).toEqual({
      role: 'rebook_app',
      tenant: '',
      actor: pair.a.userId,
      kind: 'user',
      request: 'user-req-7',
    });
  });

  it('exposes the user and request id on the handle', async () => {
    const actor = actorFor(pair.a);
    const seen = await app.tenancy.withUserContext(actor, (tx) =>
      Promise.resolve({ user: tx.user, requestId: tx.requestId }),
    );
    expect(seen).toEqual({ user: actor.user, requestId: actor.requestId });
  });

  it('rejects an invalid actor before opening a transaction', async () => {
    await expect(
      app.tenancy.withUserContext(
        { user: { id: 'nope', email: 'x@example.invalid', emailVerified: true }, requestId: 'r' },
        () => Promise.resolve('ran'),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sees zero rows in tenant-scoped tables (every tenant policy fails closed)', async () => {
    const [row] = await app.tenancy.withUserContext(actorFor(pair.a), (tx) =>
      tx.db.execute<{ locations: number; flags: number; audit: number }>(sql`
        select (select count(*) from rebook.locations)::int as locations,
               (select count(*) from rebook.tenant_feature_flags)::int as flags,
               (select count(*) from rebook.audit_logs)::int as audit
      `),
    );
    expect(row).toEqual({ locations: 0, flags: 0, audit: 0 });
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

  it('a user context after a tenant context inherits nothing from it', async () => {
    const single = await connectAppDb({ max: 1 });
    try {
      await single.tenancy.withTenant(contextFor(pair.a.id), (tx) => tx.db.execute(sql`select 1`));
      const [state] = await single.tenancy.withUserContext(actorFor(pair.b), (tx) =>
        tx.db.execute<{ tenant: string; n: number }>(
          sql`select current_setting('app.tenant_id', true) as tenant, (select count(*) from rebook.locations)::int as n`,
        ),
      );
      expect(state).toEqual({ tenant: '', n: 0 });
    } finally {
      await single.close();
    }
  });
});

describe('feature flags', () => {
  it('toggles a flag as the owner and audits actor, before and after in the same transaction', async () => {
    const flag = `probe_flag_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const actor = actorFor(pair.a, { requestId: `flags-${randomUUID()}` });
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actor);

    const first = await app.tenancy.withTenant(ctx, (tx) => toggleFeatureFlag(tx, flag, true));
    expect(first).toEqual({ flag, before: null, after: true });

    const second = await app.tenancy.withTenant(ctx, (tx) => toggleFeatureFlag(tx, flag, false));
    expect(second).toEqual({ flag, before: true, after: false });

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
        (entry) =>
          entry.actorKind === 'user' &&
          entry.actorId === pair.a.userId &&
          entry.requestId === actor.requestId,
      ),
    ).toBe(true);
  });

  it('requireFlag gates a feature and reads unset flags as off', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    await expect(
      app.tenancy.withTenant(ctx, (tx) => requireFlag(tx, 'never_set_flag')),
    ).rejects.toBeInstanceOf(FeatureDisabledError);
    await app.tenancy.withTenant(ctx, (tx) => toggleFeatureFlag(tx, 'gated_probe', true));
    await expect(
      app.tenancy.withTenant(ctx, (tx) => requireFlag(tx, 'gated_probe')),
    ).resolves.toBeUndefined();
  });

  it('is owner-only: a system actor has no role and is denied', async () => {
    await expect(
      app.tenancy.withTenant(contextFor(pair.a.id), (tx) => toggleFeatureFlag(tx, 'x_flag', true)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('rejects a malformed flag name before touching the database', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    await expect(
      app.tenancy.withTenant(ctx, (tx) => toggleFeatureFlag(tx, 'Bad Flag', true)),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('driver errors never carry bound parameters out of the runner', () => {
  it('redacts params, messages, details and stacks of a failed query while keeping the SQLSTATE', async () => {
    const marker = `secret-${randomUUID()}`;
    let caught: unknown;
    try {
      await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(sql`select ${marker}::int`),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Everything a logger could print: own properties at every level of the cause chain.
    const everything: string[] = [];
    let current: unknown = caught;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      everything.push(
        JSON.stringify(current, Object.getOwnPropertyNames(current)),
        current.stack ?? '',
        current.message,
      );
      current = (current as { cause?: unknown }).cause;
    }
    expect(everything.join('\n')).not.toContain(marker);
    expect((caught as Error).message).toContain('params: [redacted]');
    // The cause chain still identifies the failure (22P02: invalid text representation).
    expect(sqlState(caught)).toBe('22P02');
  });

  it('leaves typed domain errors untouched, quotes and all', async () => {
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    let caught: unknown;
    try {
      await app.tenancy.withTenant(ctx, (tx) =>
        updateBusinessSettings(tx, { name: 'X', businessType: 'salon', timeZone: 'UTC' }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).message).toMatch(/businessType: .*"owner"|businessType: .*option/);
    expect((caught as Error).message).not.toContain('[redacted]');
  });

  it('keeps the constraint name of a unique violation so callers can still map it', async () => {
    let caught: unknown;
    try {
      await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute(
          sql`insert into rebook.tenant_feature_flags (tenant_id, flag, enabled) values (${pair.a.id}, ${pair.a.flag}, true)`,
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(sqlState(caught)).toBe(UNIQUE_VIOLATION);
    const cause = (caught as { cause?: Error & { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe('tenant_feature_flags_pkey');
    expect(cause?.name).toBe('PostgresError');
    // Postgres's detail ("Key (tenant_id, flag)=(…) already exists") must not survive.
    const serialised =
      cause === undefined ? '' : JSON.stringify(cause, Object.getOwnPropertyNames(cause));
    expect(serialised).not.toContain(pair.a.flag);
    expect(cause?.stack ?? '').not.toContain(pair.a.flag);
  });
});
