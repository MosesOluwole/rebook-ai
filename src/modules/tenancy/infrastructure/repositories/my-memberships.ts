import { and, asc, eq, isNull } from 'drizzle-orm';

import { type BusinessType } from '../../domain/business-type';
import { type MembershipRole } from '../../domain/permissions';
import { tenantMemberships, tenants } from '../schema';
import { type UserTx } from '../tenant-tx';

export interface MyTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly businessType: BusinessType;
  readonly role: MembershipRole;
}

/**
 * The one repository that accepts a UserTx (docs/phases.md Phase 2): a signed-in user's own
 * active memberships, joined to the tenants they are a member of. Both tables are readable here
 * only through the actor branch of their policies, so the result can never include a tenant the
 * user does not belong to.
 */
export const myMembershipsRepository = {
  listMine(tx: UserTx): Promise<MyTenant[]> {
    return tx.db
      .select({
        tenantId: tenantMemberships.tenantId,
        slug: tenants.slug,
        name: tenants.name,
        businessType: tenants.businessType,
        role: tenantMemberships.role,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.userId, tx.user.id), isNull(tenantMemberships.revokedAt)))
      .orderBy(asc(tenants.name), asc(tenantMemberships.createdAt));
  },

  /** The user's active role in one tenant, or null when they are not an active member. */
  async findActiveRole(tx: UserTx, tenantId: string): Promise<MembershipRole | null> {
    const rows = await tx.db
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, tx.user.id),
          isNull(tenantMemberships.revokedAt),
        ),
      );
    return rows[0]?.role ?? null;
  },
};
