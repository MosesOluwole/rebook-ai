import { canChangeBusinessType } from '../domain/business-type';
import { BusinessTypeChangeError } from '../domain/errors';
import { parseTenantSettings, type Tenant } from '../domain/tenant';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { tenantsRepository } from '../infrastructure/repositories/tenants';
import { CHECK_VIOLATION, sqlStateOf, violatedConstraintOf } from '../infrastructure/sql-errors';
import { type TenantTx } from '../infrastructure/tenant-tx';
import { assertPermission } from './permissions-guard';

/** The current tenant for any member (workspace.view). */
export async function getCurrentTenant(tx: TenantTx): Promise<Tenant> {
  assertPermission(tx, 'workspace.view');
  const tenant = await tenantsRepository.findCurrent(tx);
  if (tenant === null) {
    throw new Error('the current tenant row is not visible inside its own context');
  }
  return tenant;
}

/**
 * Owner-only: name, business type and time zone. Audited with before and after values. A
 * midwife business cannot become a non-health business (BusinessTypeChangeError); the database
 * trigger `tenants_business_type_health_lock` enforces the same rule as a backstop.
 */
export async function updateBusinessSettings(tx: TenantTx, input: unknown): Promise<Tenant> {
  assertPermission(tx, 'settings.update');
  const settings = parseTenantSettings(input);
  const before = await tenantsRepository.findCurrent(tx);
  if (before !== null && !canChangeBusinessType(before.businessType, settings.businessType)) {
    throw new BusinessTypeChangeError();
  }
  let after: Tenant;
  try {
    after = await tenantsRepository.updateSettings(tx, settings);
  } catch (error) {
    if (
      sqlStateOf(error) === CHECK_VIOLATION &&
      violatedConstraintOf(error) === 'tenants_business_type_health_lock'
    ) {
      throw new BusinessTypeChangeError();
    }
    throw error;
  }
  await auditLogsRepository.append(tx, {
    action: 'tenant.updated',
    entityType: 'tenant',
    entityId: after.id,
    before:
      before === null
        ? null
        : { name: before.name, businessType: before.businessType, timeZone: before.timeZone },
    after: { name: after.name, businessType: after.businessType, timeZone: after.timeZone },
  });
  return after;
}
