import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { type MembershipRole } from '../../domain/permissions';
import { tenantMemberships } from '../schema';
import { type TenantTx } from '../tenant-tx';

export type { MembershipRole };

export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewMembership {
  readonly userId: string;
  readonly role: MembershipRole;
}

/** Memberships of the current tenant. Listing a user's memberships across tenants is a UserTx matter. */
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

  /**
   * Inserts the membership, or returns the existing row for (tenant, user) when another
   * transaction created it first. Never raises a unique violation; the caller decides what a
   * revoked existing row means.
   */
  async insertOrExisting(tx: TenantTx, input: NewMembership): Promise<Membership> {
    const [inserted] = await tx.db
      .insert(tenantMemberships)
      .values({ tenantId: tx.ctx.tenantId, userId: input.userId, role: input.role })
      .onConflictDoNothing({ target: [tenantMemberships.tenantId, tenantMemberships.userId] })
      .returning();
    if (inserted !== undefined) {
      return inserted;
    }
    const existing = await this.findForUser(tx, input.userId);
    if (existing === null) {
      throw new Error('tenant_memberships insert conflicted but no row is visible');
    }
    return existing;
  },

  /** Active memberships of the current tenant, oldest first. */
  listActive(tx: TenantTx): Promise<Membership[]> {
    return tx.db
      .select()
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, tx.ctx.tenantId), isNull(tenantMemberships.revokedAt)),
      )
      .orderBy(asc(tenantMemberships.createdAt), asc(tenantMemberships.id));
  },

  /** The current tenant's membership row for a user, active or revoked. */
  async findForUser(tx: TenantTx, userId: string): Promise<Membership | null> {
    const rows = await tx.db
      .select()
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, tx.ctx.tenantId), eq(tenantMemberships.userId, userId)),
      );
    return rows[0] ?? null;
  },

  async findById(tx: TenantTx, membershipId: string): Promise<Membership | null> {
    const rows = await tx.db
      .select()
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tx.ctx.tenantId),
          eq(tenantMemberships.id, membershipId),
        ),
      );
    return rows[0] ?? null;
  },

  /** Marks an active membership revoked. Returns null when there was no active row to revoke. */
  async revoke(tx: TenantTx, membershipId: string): Promise<Membership | null> {
    const [row] = await tx.db
      .update(tenantMemberships)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(tenantMemberships.tenantId, tx.ctx.tenantId),
          eq(tenantMemberships.id, membershipId),
          isNull(tenantMemberships.revokedAt),
        ),
      )
      .returning();
    return row ?? null;
  },

  /** Brings a revoked membership back with a (possibly new) role; (tenant_id, user_id) is unique. */
  async reactivate(tx: TenantTx, membershipId: string, role: MembershipRole): Promise<Membership> {
    const [row] = await tx.db
      .update(tenantMemberships)
      .set({ revokedAt: null, role })
      .where(
        and(
          eq(tenantMemberships.tenantId, tx.ctx.tenantId),
          eq(tenantMemberships.id, membershipId),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new Error('tenant_memberships reactivate affected no row');
    }
    return row;
  },
};
