import { z } from 'zod';

import { ValidationError, validationErrorFrom } from '@/shared/kernel/validation-error';

import { HealthClientFieldError } from './errors';

/**
 * Custom fields (docs/architecture.md §1 and §5, docs/phases.md Phase 3): a business defines extra
 * fields for its clients and services; values are validated by a Zod schema built from each
 * definition at write time. No clinical fields for health businesses: free-text types are off for
 * them unless an owner sets an explicit, audited override on that field.
 */

export const CUSTOM_FIELD_ENTITIES = ['client', 'service'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'select',
  'multi_select',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Types where a person can type anything, and so could record clinical detail. */
export const FREE_TEXT_TYPES: readonly CustomFieldType[] = ['text', 'long_text'];

export const OPTION_TYPES: readonly CustomFieldType[] = ['select', 'multi_select'];

export const CUSTOM_FIELD_TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  date: 'Date',
  select: 'One of a list',
  multi_select: 'Several of a list',
};

export const MAX_OPTIONS = 50;
export const MAX_TEXT_LENGTH = 200;
export const MAX_LONG_TEXT_LENGTH = 2000;

export function isFreeTextType(type: CustomFieldType): boolean {
  return FREE_TEXT_TYPES.includes(type);
}

const optionLabel = z
  .string()
  .trim()
  .min(1, 'an option cannot be blank')
  .max(80, 'at most 80 characters');

export const customFieldDefinitionInputSchema = z
  .strictObject({
    entity: z.enum(CUSTOM_FIELD_ENTITIES, 'client or service'),
    key: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]{0,39}$/,
        'lowercase letters, digits and underscores, starting with a letter',
      ),
    label: z.string().trim().min(1, 'required').max(80, 'at most 80 characters'),
    fieldType: z.enum(CUSTOM_FIELD_TYPES, 'choose a field type'),
    /** Option labels for list types, one per line in the form. */
    options: z
      .array(optionLabel)
      .max(MAX_OPTIONS, `at most ${String(MAX_OPTIONS)} options`)
      .default([]),
    required: z
      .union([z.boolean(), z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')])
      .transform((value) => value === true || value === 'on' || value === 'true')
      .default(false),
    /** The owner's explicit decision to allow a free-text field in a health business. */
    healthFreeTextOverride: z
      .union([z.boolean(), z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')])
      .transform((value) => value === true || value === 'on' || value === 'true')
      .default(false),
  })
  .superRefine((value, ctx) => {
    const isList = OPTION_TYPES.includes(value.fieldType);
    if (isList && value.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'add at least one option' });
    }
    if (!isList && value.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'only list types take options' });
    }
    if (new Set(value.options.map((o) => o.toLowerCase())).size !== value.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'options must be different' });
    }
    if (value.healthFreeTextOverride && !isFreeTextType(value.fieldType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['healthFreeTextOverride'],
        message: 'only free-text fields need the override',
      });
    }
  });

export type CustomFieldDefinitionInput = z.output<typeof customFieldDefinitionInputSchema>;

/**
 * Validates a definition. For a health business a client-scoped field is refused outright
 * (HealthClientFieldError), and a free-text service field needs the override; both are refused
 * here, before any database check.
 */
export function parseCustomFieldDefinitionInput(
  input: unknown,
  isHealthBusiness: boolean,
): CustomFieldDefinitionInput {
  const result = customFieldDefinitionInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('custom field', result.error, 'customField');
  }
  const definition = result.data;
  if (isHealthBusiness && definition.entity === 'client') {
    throw new HealthClientFieldError();
  }
  if (
    isHealthBusiness &&
    isFreeTextType(definition.fieldType) &&
    !definition.healthFreeTextOverride
  ) {
    const message =
      'free-text fields are off for health businesses so no clinical detail is recorded; an owner can enable one with the override';
    throw new ValidationError('custom field', [`fieldType: ${message}`], { fieldType: [message] });
  }
  return definition;
}

export interface CustomFieldDefinition {
  readonly id: string;
  readonly entity: CustomFieldEntity;
  readonly key: string;
  readonly label: string;
  readonly fieldType: CustomFieldType;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly healthFreeTextOverride: boolean;
}

/** A stored value: the JSON form of what the definition's schema accepts. */
export type CustomFieldValue = string | number | boolean | readonly string[];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * The Zod schema for one definition's value (docs/architecture.md §5). Accepts what a form posts
 * (strings, "on" for a ticked box, string arrays for several choices) as well as typed JSON, and
 * outputs the stored JSON value, or null for "no value" (allowed only when not required).
 */
export function valueSchemaFor(
  definition: CustomFieldDefinition,
): z.ZodType<CustomFieldValue | null> {
  // Blank text, and an empty list (a multi-select with nothing ticked), mean "no value".
  const blankToNull = (value: unknown) =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
      ? null
      : value;

  let present: z.ZodType<CustomFieldValue>;
  switch (definition.fieldType) {
    case 'text':
      present = z
        .string()
        .trim()
        .max(MAX_TEXT_LENGTH, `at most ${String(MAX_TEXT_LENGTH)} characters`);
      break;
    case 'long_text':
      present = z
        .string()
        .trim()
        .max(MAX_LONG_TEXT_LENGTH, `at most ${String(MAX_LONG_TEXT_LENGTH)} characters`);
      break;
    case 'number':
      present = z
        .union([
          z.number(),
          z
            .string()
            .trim()
            .regex(/^-?\d{1,12}(?:\.\d{1,4})?$/, 'a number such as 12 or 12.5')
            .transform(Number),
        ])
        .pipe(z.number());
      break;
    case 'boolean':
      present = z
        .union([z.boolean(), z.enum(['on', 'true', 'false', 'yes', 'no'], 'yes or no')])
        .transform(
          (value) => value === true || value === 'on' || value === 'true' || value === 'yes',
        );
      break;
    case 'date':
      present = z.string().trim().refine(isRealDate, 'a date such as 2026-11-14');
      break;
    case 'select':
      present = z.enum(definition.options as [string, ...string[]], 'one of the listed options');
      break;
    case 'multi_select':
      present = z
        .union([z.string(), z.array(z.string())])
        .transform((value) => (Array.isArray(value) ? value : [value]))
        .pipe(
          z
            .array(z.enum(definition.options as [string, ...string[]], 'one of the listed options'))
            .min(1, 'choose at least one')
            .refine((values) => new Set(values).size === values.length, 'each option once'),
        );
      break;
  }
  const missing = definition.required ? z.never('required') : z.null();
  return z.preprocess(blankToNull, z.union([missing, present]));
}

/**
 * Validates a set of values against their definitions, keyed by definition key. Unknown keys are
 * refused; required fields must be present. Output: definition id → value (null clears it).
 */
export function parseCustomFieldValues(
  definitions: readonly CustomFieldDefinition[],
  input: Readonly<Record<string, unknown>>,
): Map<string, CustomFieldValue | null> {
  const issues: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  const fail = (path: string, message: string) => {
    issues.push(`${path}: ${message}`);
    (fieldErrors[path] ??= []).push(message);
  };
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) {
      fail(key, 'not a field of this record');
    }
  }
  const values = new Map<string, CustomFieldValue | null>();
  for (const definition of definitions) {
    const result = valueSchemaFor(definition).safeParse(input[definition.key]);
    if (result.success) {
      values.set(definition.id, result.data);
    } else {
      fail(definition.key, result.error.issues[0]?.message ?? 'invalid');
    }
  }
  if (issues.length > 0) {
    throw new ValidationError('custom field values', issues, fieldErrors);
  }
  return values;
}
