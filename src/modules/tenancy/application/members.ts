import { CannotRevokeSelfError, NotFoundError } from '../domain/errors';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { type Membership, membershipsRepository } from '../infrastructure/repositories/memberships';
import { type TenantTx } from '../infrastructure/tenant-tx';
import { requireId } from './ids';
import { assertPermission } from './permissions-guard';

export type { Membership };

/** Any member may see who else is in the business. */
export function listMembers(tx: TenantTx): Promise<Membership[]> {
  assertPermission(tx, 'workspace.view');
  return membershipsRepository.listActive(tx);
}

/**
 * Owner-only. An owner cannot revoke themselves (that would be a lock-out); revoking a membership
 * that is not active is a NotFoundError.
 */
export async function revokeMember(tx: TenantTx, membershipId: string): Promise<Membership> {
  assertPermission(tx, 'members.revoke');
  const target = await membershipsRepository.findById(tx, requireId(membershipId));
  if (target?.revokedAt !== null) {
    throw new NotFoundError();
  }
  if (target.userId === tx.ctx.actorId) {
    throw new CannotRevokeSelfError();
  }
  const revoked = await membershipsRepository.revoke(tx, membershipId);
  if (revoked === null) {
    throw new NotFoundError();
  }
  await auditLogsRepository.append(tx, {
    action: 'membership.revoked',
    entityType: 'tenant_membership',
    entityId: revoked.id,
    before: { role: revoked.role, active: true },
    after: { role: revoked.role, active: false },
  });
  return revoked;
}
