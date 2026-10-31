import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/shared/kernel/validation-error';

import { HealthClientFieldError } from './errors';
import {
  type CustomFieldDefinition,
  parseCustomFieldDefinitionInput,
  parseCustomFieldValues,
  valueSchemaFor,
} from './custom-field';

/**
 * Phase 3 acceptance: a health business cannot create a free-text custom field without an
 * explicit override; custom field values failing their definition's type or options are
 * rejected. Values are validated by a Zod schema built from each definition.
 */

function definition(overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition {
  return {
    id: 'def-1',
    entity: 'service',
    key: 'field',
    label: 'Field',
    fieldType: 'text',
    options: [],
    required: false,
    healthFreeTextOverride: false,
    ...overrides,
  };
}

describe('definitions', () => {
  it.each(['text', 'long_text'])(
    'refuses a %s field for a health business without the override',
    (fieldType) => {
      expect(() =>
        parseCustomFieldDefinitionInput(
          { entity: 'service', key: 'notes', label: 'Notes', fieldType },
          true,
        ),
      ).toThrow(ValidationError);
    },
  );

  it('accepts it with the override, and accepts it without one for a non-health business', () => {
    expect(
      parseCustomFieldDefinitionInput(
        {
          entity: 'service',
          key: 'notes',
          label: 'Notes',
          fieldType: 'text',
          healthFreeTextOverride: 'on',
        },
        true,
      ).healthFreeTextOverride,
    ).toBe(true);
    expect(
      parseCustomFieldDefinitionInput(
        { entity: 'service', key: 'notes', label: 'Notes', fieldType: 'long_text' },
        false,
      ).fieldType,
    ).toBe('long_text');
  });

  it('allows structured types for a health business without any override', () => {
    for (const fieldType of ['number', 'boolean', 'date']) {
      expect(
        parseCustomFieldDefinitionInput(
          { entity: 'service', key: 'k', label: 'L', fieldType },
          true,
        ).fieldType,
      ).toBe(fieldType);
    }
  });

  it('needs options for list types only, distinct and non-blank, and the override only on free text', () => {
    const fails = (input: Record<string, unknown>) => {
      expect(() =>
        parseCustomFieldDefinitionInput(
          { entity: 'service', key: 'k', label: 'L', ...input },
          false,
        ),
      ).toThrow(ValidationError);
    };
    fails({ fieldType: 'select', options: [] });
    fails({ fieldType: 'number', options: ['a'] });
    fails({ fieldType: 'select', options: ['Blue', 'blue'] });
    fails({ fieldType: 'select', options: [' '] });
    fails({ fieldType: 'number', healthFreeTextOverride: true });
    fails({ fieldType: 'text', key: 'Bad Key' });
    fails({ fieldType: 'text', entity: 'booking' });
  });
});

describe('client-scoped fields', () => {
  it('are refused for a health business, whatever the type or override', () => {
    for (const input of [
      { fieldType: 'number' },
      { fieldType: 'date' },
      { fieldType: 'text', healthFreeTextOverride: true },
    ]) {
      expect(() =>
        parseCustomFieldDefinitionInput({ entity: 'client', key: 'k', label: 'L', ...input }, true),
      ).toThrow(HealthClientFieldError);
    }
  });

  it('are allowed for other businesses', () => {
    expect(
      parseCustomFieldDefinitionInput(
        { entity: 'client', key: 'k', label: 'L', fieldType: 'number' },
        false,
      ).entity,
    ).toBe('client');
  });
});

describe('valueSchemaFor', () => {
  it('validates each type and outputs the stored JSON value', () => {
    expect(valueSchemaFor(definition({ fieldType: 'number' })).parse('12.5')).toBe(12.5);
    expect(valueSchemaFor(definition({ fieldType: 'boolean' })).parse('on')).toBe(true);
    expect(valueSchemaFor(definition({ fieldType: 'date' })).parse('2026-11-14')).toBe(
      '2026-11-14',
    );
    expect(
      valueSchemaFor(definition({ fieldType: 'select', options: ['Blue', 'Green'] })).parse(
        'Green',
      ),
    ).toBe('Green');
    expect(
      valueSchemaFor(definition({ fieldType: 'multi_select', options: ['A', 'B', 'C'] })).parse([
        'A',
        'C',
      ]),
    ).toEqual(['A', 'C']);
    expect(valueSchemaFor(definition({ fieldType: 'text' })).parse('  Room 2 ')).toBe('Room 2');
  });

  it.each([
    [{ fieldType: 'number' }, 'twelve'],
    [{ fieldType: 'number' }, '1e9'],
    [{ fieldType: 'boolean' }, 'maybe'],
    [{ fieldType: 'date' }, '2026-02-30'],
    [{ fieldType: 'date' }, '14/11/2026'],
    [{ fieldType: 'select', options: ['Blue', 'Green'] }, 'Red'],
    [{ fieldType: 'multi_select', options: ['A', 'B'] }, ['A', 'Z']],
    [{ fieldType: 'multi_select', options: ['A', 'B'] }, ['A', 'A']],
    [{ fieldType: 'text' }, 'x'.repeat(201)],
    [{ fieldType: 'text' }, 42],
  ] as const)('refuses %j given %j', (overrides, value) => {
    expect(
      valueSchemaFor(definition(overrides as Partial<CustomFieldDefinition>)).safeParse(value)
        .success,
    ).toBe(false);
  });

  it('treats blank as no value, which a required field refuses', () => {
    expect(valueSchemaFor(definition({ fieldType: 'number' })).parse('')).toBeNull();
    expect(
      valueSchemaFor(definition({ fieldType: 'number', required: true })).safeParse('').success,
    ).toBe(false);
  });
});

describe('parseCustomFieldValues', () => {
  const definitions = [
    definition({
      id: 'd-room',
      key: 'room',
      fieldType: 'select',
      options: ['Blue'],
      required: true,
    }),
    definition({ id: 'd-size', key: 'size', fieldType: 'number' }),
  ];

  it('maps definition ids to values and clears blanks', () => {
    expect(parseCustomFieldValues(definitions, { room: 'Blue', size: '' })).toEqual(
      new Map([
        ['d-room', 'Blue'],
        ['d-size', null],
      ]),
    );
  });

  it('refuses unknown keys and reports each failing field by key', () => {
    try {
      parseCustomFieldValues(definitions, { room: 'Red', size: 'big', colour: 'x' });
      throw new Error('expected a ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(Object.keys((error as ValidationError).fieldErrors).sort()).toEqual([
        'colour',
        'room',
        'size',
      ]);
    }
  });
});
