import { eq, sql } from 'drizzle-orm';

import { type NewTenant, type Tenant, type TenantSettings } from '../../domain/tenant';
import { tenants } from '../schema';
import { type TenantTx } from '../tenant-tx';

/**
 * The tenants policies allow a row to be read or inserted only where `id` equals the current
 * tenant (plus, for user actors, the tenants they are a member of), so onboarding generates the
 * id, opens the context with it, then inserts.
 */
export const tenantsRepository = {
  async insert(tx: TenantTx, input: NewTenant & { readonly id: string }): Promise<Tenant> {
    const [row] = await tx.db
      .insert(tenants)
      .values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        businessType: input.businessType,
        timeZone: input.timeZone,
      })
      .returning();
    if (row === undefined) {
      throw new Error('tenants insert returned no row');
    }
    return row;
  },

  async findCurrent(tx: TenantTx): Promise<Tenant | null> {
    const rows = await tx.db.select().from(tenants).where(eq(tenants.id, tx.ctx.tenantId));
    return rows[0] ?? null;
  },

  /**
   * The current tenant, row-locked until the transaction ends. `update` is taken by a business
   * type change; `share` by commands whose validity depends on the business type (creating a
   * service). The two conflict, so a service cannot appear between the "no services yet" check
   * and the type change, nor be created under a type that is being changed (docs/phases.md
   * Phase 3). Both need the app role's UPDATE privilege on tenants, which only rebook_app holds.
   */
  async lockCurrent(tx: TenantTx, mode: 'share' | 'update'): Promise<Tenant | null> {
    const query = tx.db.select().from(tenants).where(eq(tenants.id, tx.ctx.tenantId));
    const rows = await (mode === 'update' ? query.for('update') : query.for('share'));
    return rows[0] ?? null;
  },

  /** Name, business type and time zone of the current tenant. The slug never changes. */
  async updateSettings(tx: TenantTx, settings: TenantSettings): Promise<Tenant> {
    const [row] = await tx.db
      .update(tenants)
      .set({
        name: settings.name,
        businessType: settings.businessType,
        timeZone: settings.timeZone,
        updatedAt: sql`now()`,
      })
      .where(eq(tenants.id, tx.ctx.tenantId))
      .returning();
    if (row === undefined) {
      throw new Error('tenants update affected no row');
    }
    return row;
  },
};
