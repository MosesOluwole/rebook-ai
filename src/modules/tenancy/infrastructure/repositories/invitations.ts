import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { type MembershipRole } from '../../domain/permissions';
import { tenantInvitations } from '../schema';
import { type TenantTx } from '../tenant-tx';

export interface Invitation {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly tokenHash: string;
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedBy: string | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewInvitation {
  readonly email: string;
  readonly role: MembershipRole;
  readonly tokenHash: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

export const invitationsRepository = {
  async insert(tx: TenantTx, input: NewInvitation): Promise<Invitation> {
    const [row] = await tx.db
      .insert(tenantInvitations)
      .values({ tenantId: tx.ctx.tenantId, ...input })
      .returning();
    if (row === undefined) {
      throw new Error('tenant_invitations insert returned no row');
    }
    return row;
  },

  /**
   * Finds the invitation behind a link and locks its row for the rest of the transaction, so
   * two acceptances of the same link run one after the other: the second sees the first's
   * `accepted_at` and takes the idempotent path instead of racing the membership insert.
   */
  async findByTokenHashForUpdate(tx: TenantTx, tokenHash: string): Promise<Invitation | null> {
    const rows = await tx.db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tx.ctx.tenantId),
          eq(tenantInvitations.tokenHash, tokenHash),
        ),
      )
      .for('update');
    return rows[0] ?? null;
  },

  /** The open (not accepted, not revoked) invitation for an address, if any. Addresses are stored lower-cased. */
  async findOpenByEmail(tx: TenantTx, email: string): Promise<Invitation | null> {
    const rows = await tx.db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tx.ctx.tenantId),
          eq(tenantInvitations.email, email),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
        ),
      );
    return rows[0] ?? null;
  },

  /** Not accepted and not revoked (expired ones included, so the owner can see and revoke them). */
  listOpen(tx: TenantTx): Promise<Invitation[]> {
    return tx.db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tx.ctx.tenantId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
        ),
      )
      .orderBy(asc(tenantInvitations.createdAt), asc(tenantInvitations.id));
  },

  async markAccepted(tx: TenantTx, invitationId: string, userId: string): Promise<Invitation> {
    const [row] = await tx.db
      .update(tenantInvitations)
      .set({ acceptedAt: sql`now()`, acceptedBy: userId })
      .where(
        and(
          eq(tenantInvitations.tenantId, tx.ctx.tenantId),
          eq(tenantInvitations.id, invitationId),
          isNull(tenantInvitations.acceptedAt),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new Error('tenant_invitations accept affected no row');
    }
    return row;
  },

  /** Revokes an open invitation. Returns null when there was nothing open to revoke. */
  async revoke(tx: TenantTx, invitationId: string): Promise<Invitation | null> {
    const [row] = await tx.db
      .update(tenantInvitations)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(tenantInvitations.tenantId, tx.ctx.tenantId),
          eq(tenantInvitations.id, invitationId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
        ),
      )
      .returning();
    return row ?? null;
  },
};
