/**
 * CRM module: custom fields now (docs/architecture.md §3 and §5, docs/phases.md Phase 3);
 * customers, matching, merges, import and export in later phases.
 *
 * Definitions are per entity (client, service). Values are validated at write time by a Zod
 * schema built from each definition. Health businesses get no free-text fields without an
 * owner's explicit, audited override on the field.
 */

// ---- Domain ------------------------------------------------------------------------------
export {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  FREE_TEXT_TYPES,
  isFreeTextType,
  MAX_OPTIONS,
  OPTION_TYPES,
  parseCustomFieldDefinitionInput,
  parseCustomFieldValues,
  valueSchemaFor,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldEntity,
  type CustomFieldType,
  type CustomFieldValue,
} from './domain/custom-field';
export { HealthClientFieldError } from './domain/errors';

// ---- Application --------------------------------------------------------------------------
export {
  businessTypeGuard,
  createCustomFieldDefinition,
  deleteCustomFieldDefinition,
  getServiceCustomFieldValues,
  listCustomFieldDefinitions,
  setServiceCustomFieldValues,
} from './application/custom-fields';

// ---- Infrastructure -----------------------------------------------------------------------
// Exported for Drizzle Kit and later composite foreign keys only; never query them directly.
export { customFieldDefinitions, customFieldValues } from './infrastructure/schema';
