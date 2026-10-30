import { describe, expect, it } from 'vitest';

import { tenantsRepository, type TenantContext } from '@/modules/tenancy';
import { createDbClient } from '@/shared/db/client';

/**
 * Phase 1 acceptance criterion: a repository cannot be called without the TenantTx handle.
 * The `@ts-expect-error` below fails `pnpm typecheck` if the call ever compiles.
 */
describe('TenantTx brand', () => {
  it('rejects a bare database handle at compile time', async () => {
    // postgres.js connects lazily, so no connection is made for this unused client.
    const client = createDbClient('postgresql://nobody:nobody@127.0.0.1:1/unused', { max: 1 });
    const ctx: TenantContext = {
      tenantId: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f',
      actorKind: 'system',
      actorId: null,
      requestId: 'type-test',
    };

    // @ts-expect-error a plain database handle is not a TenantTx; only withTenant produces one
    const attempt = () => tenantsRepository.findCurrent({ db: client.db, ctx, role: 'rebook_app' });

    expect(attempt).toBeTypeOf('function');
    await client.close();
  });
});
