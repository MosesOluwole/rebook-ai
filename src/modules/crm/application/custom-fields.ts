import { getService, tenantHasServices } from '@/modules/booking';
import {
  assertPermission,
  auditLogsRepository,
  type BusinessTypeGuard,
  CHECK_VIOLATION,
  isHealthBusiness,
  NotFoundError,
  requireId,
  sqlStateOf,
  type TenantTx,
  tenantsRepository,
  UNIQUE_VIOLATION,
  ValidationError,
  violatedConstraintOf,
} from '@/modules/tenancy';

import {
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type CustomFieldValue,
  isFreeTextType,
  parseCustomFieldDefinitionInput,
  parseCustomFieldValues,
} from '../domain/custom-field';
import { HealthClientFieldError } from '../domain/errors';
import {
  anyBarredForHealth,
  definitionsRepository,
  valuesRepository,
} from '../infrastructure/repositories';

/**
 * Everything settings needs to judge a business type change (ADR-005 §2 and §6): services lock
 * the type; client fields and un-overridden free-text fields keep a business from becoming a
 * health business. Runs inside `updateBusinessSettings`, which has already checked permission.
 */
export const businessTypeGuard: BusinessTypeGuard = {
  hasServices: tenantHasServices,
  hasFieldsBarredForHealth: anyBarredForHealth,
};

const KEY_TAKEN = 'already used by another field of this kind';
const HEALTH_CLIENT_CONSTRAINT = 'custom_field_definitions_health_client';
const HEALTH_FREE_TEXT =
  'free-text fields are off for health businesses so no clinical detail is recorded; an owner can enable one with the override';

function definitionSnapshot(definition: CustomFieldDefinition) {
  return {
    entity: definition.entity,
    key: definition.key,
    label: definition.label,
    fieldType: definition.fieldType,
    options: [...definition.options],
    required: definition.required,
    healthFreeTextOverride: definition.healthFreeTextOverride,
  };
}

function requestsOverride(input: unknown): boolean {
  const value =
    typeof input === 'object' && input !== null
      ? (input as { healthFreeTextOverride?: unknown }).healthFreeTextOverride
      : undefined;
  return value === true || value === 'on' || value === 'true';
}

/**
 * Owner-only. Defines a custom field for clients or services (docs/architecture.md §5).
 *
 * For a health business a free-text field is refused unless the input carries the override, and
 * setting the override needs its own permission (`custom_fields.health_override`) and writes its
 * own audit entry, `custom_field.health_override_enabled`, in the same transaction. The tenant row
 * is share-locked so the business type cannot change underneath the decision. The trigger
 * `custom_field_definitions_health_rules` refuses the same thing in the database. A health
 * business cannot define client-scoped fields at all (HealthClientFieldError).
 */
export async function createCustomFieldDefinition(
  tx: TenantTx,
  input: unknown,
): Promise<CustomFieldDefinition> {
  // A request for the override is judged on its own permission first, then on the field's.
  if (requestsOverride(input)) {
    assertPermission(tx, 'custom_fields.health_override');
  }
  assertPermission(tx, 'custom_fields.manage');
  const tenant = await tenantsRepository.lockCurrent(tx, 'share');
  if (tenant === null) {
    throw new NotFoundError();
  }
  const health = isHealthBusiness(tenant.businessType);
  const parsed = parseCustomFieldDefinitionInput(input, health);
  // The override means something only for a health business; elsewhere free text is allowed.
  const override = health && isFreeTextType(parsed.fieldType) && parsed.healthFreeTextOverride;
  let definition: CustomFieldDefinition;
  try {
    definition = await definitionsRepository.insert(tx, {
      ...parsed,
      healthFreeTextOverride: override,
    });
  } catch (error) {
    const constraint = sqlStateOf(error) === undefined ? undefined : violatedConstraintOf(error);
    if (
      sqlStateOf(error) === UNIQUE_VIOLATION &&
      constraint === 'custom_field_definitions_tenant_id_entity_key_unique'
    ) {
      throw new ValidationError('custom field', [`key: ${KEY_TAKEN}`], { key: [KEY_TAKEN] });
    }
    if (sqlStateOf(error) === CHECK_VIOLATION && constraint === HEALTH_CLIENT_CONSTRAINT) {
      throw new HealthClientFieldError();
    }
    if (
      sqlStateOf(error) === CHECK_VIOLATION &&
      constraint === 'custom_field_definitions_health_free_text'
    ) {
      throw new ValidationError('custom field', [`fieldType: ${HEALTH_FREE_TEXT}`], {
        fieldType: [HEALTH_FREE_TEXT],
      });
    }
    throw error;
  }
  await auditLogsRepository.append(tx, {
    action: 'custom_field.created',
    entityType: 'custom_field_definition',
    entityId: definition.id,
    after: definitionSnapshot(definition),
  });
  if (override) {
    await auditLogsRepository.append(tx, {
      action: 'custom_field.health_override_enabled',
      entityType: 'custom_field_definition',
      entityId: definition.id,
      before: { healthFreeTextOverride: false },
      after: {
        healthFreeTextOverride: true,
        key: definition.key,
        fieldType: definition.fieldType,
        businessType: tenant.businessType,
      },
    });
  }
  return definition;
}

/** Owner-only. Deletes a definition and every value stored for it. Audited. */
export async function deleteCustomFieldDefinition(tx: TenantTx, id: string): Promise<void> {
  assertPermission(tx, 'custom_fields.manage');
  const deleted = await definitionsRepository.delete(tx, requireId(id));
  if (deleted === null) {
    throw new NotFoundError();
  }
  await auditLogsRepository.append(tx, {
    action: 'custom_field.deleted',
    entityType: 'custom_field_definition',
    entityId: deleted.id,
    before: definitionSnapshot(deleted),
  });
}

export function listCustomFieldDefinitions(
  tx: TenantTx,
  entity?: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  assertPermission(tx, 'workspace.view');
  return definitionsRepository.list(tx, entity);
}

/**
 * Owner-only. Sets the whole set of a service's custom field values, keyed by definition key (a key
 * left out is cleared, like a blank optional value). Each value is checked
 * by the Zod schema built from its definition (type, options, required); a blank optional value
 * clears it. Any failure refuses the whole set with a message per field.
 */
export async function setServiceCustomFieldValues(
  tx: TenantTx,
  serviceId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<Map<string, CustomFieldValue | null>> {
  assertPermission(tx, 'services.manage');
  await getService(tx, serviceId);
  const definitions = await definitionsRepository.list(tx, 'service');
  const values = parseCustomFieldValues(definitions, input);
  for (const [definitionId, value] of values) {
    if (value === null) {
      await valuesRepository.deleteForService(tx, serviceId, definitionId);
    } else {
      await valuesRepository.upsertForService(tx, serviceId, definitionId, value);
    }
  }
  return values;
}

/** A service's stored values, keyed by definition key. */
export async function getServiceCustomFieldValues(
  tx: TenantTx,
  serviceId: string,
): Promise<Map<string, unknown>> {
  assertPermission(tx, 'workspace.view');
  await getService(tx, serviceId);
  const definitions = await definitionsRepository.list(tx, 'service');
  const keyOf = new Map(definitions.map((d) => [d.id, d.key]));
  const result = new Map<string, unknown>();
  for (const row of await valuesRepository.listForService(tx, serviceId)) {
    const key = keyOf.get(row.definitionId);
    if (key !== undefined) {
      result.set(key, row.value);
    }
  }
  return result;
}
