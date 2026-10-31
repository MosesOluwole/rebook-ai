import { assertCan, type Permission, PermissionDeniedError } from '../domain/permissions';
import { type TenantTx } from '../infrastructure/tenant-tx';

/**
 * Every application command calls this first (docs/architecture.md §4). Only a user acting under
 * a membership grant has a role; registration and invitation grants, and non-user actors, hold no
 * permission at all.
 */
export function assertPermission(tx: TenantTx, permission: Permission): void {
  const context = tx.context;
  if (context.actorKind !== 'user' || context.role === null) {
    throw new PermissionDeniedError('none', permission);
  }
  assertCan(context.role, permission);
}
