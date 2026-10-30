import { and, asc, eq, isNull } from 'drizzle-orm';

import { tenantMemberships } from '../schema';
import { type TenantTx } from '../tenant-tx';

export type MembershipRole = 'owner' | 'staff';

export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewMembership {
  readonly userId: string;
  readonly role: MembershipRole;
}

export const membershipsRepository = {
  async insert(tx: TenantTx, input: NewMembership): Promise<Membership> {
    const [row] = await tx.db
      .insert(tenantMemberships)
      .values({ tenantId: tx.ctx.tenantId, userId: input.userId, role: input.role })
      .returning();
    if (row === undefined) {
      throw new Error('tenant_memberships insert returned no row');
    }
    return row;
  },

  /** Active memberships of the current tenant. */
  listActive(tx: TenantTx): Promise<Membership[]> {
    return tx.db
      .select()
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, tx.ctx.tenantId), isNull(tenantMemberships.revokedAt)),
      )
      .orderBy(asc(tenantMemberships.createdAt), asc(tenantMemberships.id));
  },

  /**
   * Every active membership of the current actor, across tenants. The select policy allows
   * rows where `user_id` is the current actor, so this is how a signed-in user's tenants are
   * listed before one is chosen.
   */
  listForCurrentActor(tx: TenantTx): Promise<Membership[]> {
    const actorId = tx.ctx.actorId;
    if (actorId === null) {
      return Promise.resolve([]);
    }
    return tx.db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, actorId), isNull(tenantMemberships.revokedAt)))
      .orderBy(asc(tenantMemberships.createdAt), asc(tenantMemberships.id));
  },
};
