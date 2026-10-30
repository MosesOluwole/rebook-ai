import { parseFeatureFlagName } from '../domain/feature-flag';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { featureFlagsRepository } from '../infrastructure/repositories/feature-flags';
import { type TenantTx } from '../infrastructure/tenant-tx';

/** Whether a flag is on for the current tenant. Unset flags are off. */
export async function isFeatureEnabled(tx: TenantTx, flag: string): Promise<boolean> {
  return (await featureFlagsRepository.get(tx, parseFeatureFlagName(flag))) ?? false;
}

/**
 * Turns a flag on or off and records the change in audit_logs inside the same transaction
 * (docs/architecture.md §4: flag changes are audited). Returns the previous stored value.
 */
export async function setFeatureFlag(
  tx: TenantTx,
  flag: string,
  enabled: boolean,
): Promise<{ readonly before: boolean | null; readonly after: boolean }> {
  const name = parseFeatureFlagName(flag);
  const before = await featureFlagsRepository.get(tx, name);
  await featureFlagsRepository.set(tx, name, enabled);
  await auditLogsRepository.append(tx, {
    action: 'feature_flag.updated',
    entityType: 'tenant_feature_flag',
    before: before === null ? null : { flag: name, enabled: before },
    after: { flag: name, enabled },
  });
  return { before, after: enabled };
}
