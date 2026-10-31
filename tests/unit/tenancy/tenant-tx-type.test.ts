import { describe, expect, it } from 'vitest';

import {
  type AnonymousTx,
  createTenancy,
  listMembers,
  tenantsRepository,
  type TenantContext,
  type UserTx,
} from '@/modules/tenancy';
import { createDbClient } from '@/shared/db/client';

/**
 * Compile-time guarantees of the tenancy handles. Each `@ts-expect-error` below fails
 * `pnpm typecheck` if the call ever compiles.
 *
 * - Phase 1: a repository cannot be called without the TenantTx handle.
 * - Phase 2: `withTenant` cannot be called for a user actor without an `AuthorisedTenantContext`,
 *   and a UserTx (actor only, no tenant) is not accepted where a TenantTx is required.
 */
describe('tenancy handle brands', () => {
  // postgres.js connects lazily, so no connection is made for this unused client.
  const client = createDbClient('postgresql://nobody:nobody@127.0.0.1:1/unused', { max: 1 });
  const tenancy = createTenancy(
    client.db,
    { now: () => new Date(0) },
    { ownerJoined: () => Promise.resolve() },
  );
  const tenantId = '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f';
  const userId = '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e70';

  it('rejects a bare database handle where a TenantTx is required', () => {
    const ctx: TenantContext = { tenantId, actorKind: 'system', actorId: null, requestId: 't' };
    const attempt = () =>
      // @ts-expect-error a plain database handle is not a TenantTx; only withTenant produces one
      tenantsRepository.findCurrent({ db: client.db, ctx, context: ctx, role: 'rebook_app' });
    expect(attempt).toBeTypeOf('function');
  });

  it('rejects a user actor that is not an AuthorisedTenantContext', () => {
    const attempt = () =>
      tenancy.withTenant(
        // @ts-expect-error a user context must come from resolveTenantForUser, onboarding or invite acceptance
        { tenantId, actorKind: 'user', actorId: userId, requestId: 'forged' },
        () => Promise.resolve('ran'),
      );
    expect(attempt).toBeTypeOf('function');
  });

  it('rejects a user actor whose kind is only known at runtime', () => {
    const ctx: TenantContext = { tenantId, actorKind: 'user', actorId: userId, requestId: 'wide' };
    const attempt = () =>
      // @ts-expect-error a TenantContext whose actorKind may be 'user' is not accepted either
      tenancy.withTenant(ctx, () => Promise.resolve('ran'));
    expect(attempt).toBeTypeOf('function');
  });

  it('still accepts non-user actors as plain objects', () => {
    const attempt = () =>
      tenancy.withTenant({ tenantId, actorKind: 'worker', actorId: null, requestId: 'job' }, () =>
        Promise.resolve('ran'),
      );
    expect(attempt).toBeTypeOf('function');
  });

  it('rejects an AnonymousTx where a TenantTx is required', () => {
    const attempt = (atx: AnonymousTx) =>
      // @ts-expect-error an AnonymousTx has neither tenant nor user; only platform tables accept it
      listMembers(atx);
    expect(attempt).toBeTypeOf('function');
  });

  it('rejects a UserTx where a TenantTx is required', () => {
    const attempt = (utx: UserTx) =>
      // @ts-expect-error a UserTx has no tenant; only the "list my memberships" repository takes it
      listMembers(utx);
    expect(attempt).toBeTypeOf('function');
  });
});
