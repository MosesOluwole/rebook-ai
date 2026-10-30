import { and, eq, sql } from 'drizzle-orm';

import { tenantFeatureFlags } from '../schema';
import { type TenantTx } from '../tenant-tx';

/**
 * Raw flag storage. Not part of the module's public surface: toggles must go through the
 * application function `setFeatureFlag`, which audits the change in the same transaction.
 */
export const featureFlagsRepository = {
  /** The stored value, or null when the tenant has never set the flag. */
  async get(tx: TenantTx, flag: string): Promise<boolean | null> {
    const rows = await tx.db
      .select({ enabled: tenantFeatureFlags.enabled })
      .from(tenantFeatureFlags)
      .where(
        and(eq(tenantFeatureFlags.tenantId, tx.ctx.tenantId), eq(tenantFeatureFlags.flag, flag)),
      );
    return rows[0]?.enabled ?? null;
  },

  async set(tx: TenantTx, flag: string, enabled: boolean): Promise<void> {
    await tx.db
      .insert(tenantFeatureFlags)
      .values({ tenantId: tx.ctx.tenantId, flag, enabled })
      .onConflictDoUpdate({
        target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flag],
        set: { enabled, updatedAt: sql`now()` },
      });
  },
};
