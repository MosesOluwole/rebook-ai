import { businessTypeChangeRefusal } from '../domain/business-type';
import {
  BusinessTypeChangeError,
  BusinessTypeLockedError,
  HealthCustomFieldsError,
} from '../domain/errors';
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
 * What settings needs to know about the rest of the system to judge a business type change.
 * Tenancy cannot import booking or crm (both depend on tenancy), so the caller supplies it:
 * `businessTypeGuard` from `@/modules/crm`.
 */
export interface BusinessTypeGuard {
  hasServices(tx: TenantTx): Promise<boolean>;
  /** Custom fields a health business may not hold: client-scoped, or free text without override. */
  hasFieldsBarredForHealth(tx: TenantTx): Promise<boolean>;
}

/**
 * Owner-only: name, business type and time zone. Audited with before and after values.
 *
 * A midwife business cannot become a non-health business (BusinessTypeChangeError), and no
 * business can change type once it has any service (BusinessTypeLockedError). The tenant row is
 * locked first, so a service created concurrently waits for this transaction (see
 * `tenantsRepository.lockCurrent`). The database triggers `tenants_business_type_health_lock` and
 * `tenants_business_type_service_lock` enforce both rules as the backstop. Becoming a health
 * business with client custom fields or un-overridden free-text fields is refused
 * (HealthCustomFieldsError; trigger `tenants_business_type_custom_fields_lock`).
 */
export async function updateBusinessSettings(
  tx: TenantTx,
  input: unknown,
  guard: BusinessTypeGuard,
): Promise<Tenant> {
  assertPermission(tx, 'settings.update');
  const settings = parseTenantSettings(input);
  const before = await tenantsRepository.lockCurrent(tx, 'update');
  if (before !== null && before.businessType !== settings.businessType) {
    const refusal = businessTypeChangeRefusal(
      before.businessType,
      settings.businessType,
      await guard.hasServices(tx),
      await guard.hasFieldsBarredForHealth(tx),
    );
    if (refusal === 'health_lock') {
      throw new BusinessTypeChangeError();
    }
    if (refusal === 'services_exist') {
      throw new BusinessTypeLockedError();
    }
    if (refusal === 'custom_fields') {
      throw new HealthCustomFieldsError();
    }
  }
  let after: Tenant;
  try {
    after = await tenantsRepository.updateSettings(tx, settings);
  } catch (error) {
    if (sqlStateOf(error) === CHECK_VIOLATION) {
      const constraint = violatedConstraintOf(error);
      if (constraint === 'tenants_business_type_health_lock') {
        throw new BusinessTypeChangeError();
      }
      if (constraint === 'tenants_business_type_service_lock') {
        throw new BusinessTypeLockedError();
      }
      if (constraint === 'tenants_business_type_custom_fields_lock') {
        throw new HealthCustomFieldsError();
      }
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
