import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import { parseNewTenant } from './tenant';

describe('parseNewTenant', () => {
  it('accepts a valid tenant and trims the name', () => {
    expect(
      parseNewTenant({ name: '  Acme Events ', slug: 'acme-events', timeZone: 'Europe/London' }),
    ).toEqual({ name: 'Acme Events', slug: 'acme-events', timeZone: 'Europe/London' });
  });

  it.each([
    { name: 'an empty name', input: { name: '  ', slug: 'acme', timeZone: 'Europe/London' } },
    {
      name: 'a 121-character name',
      input: { name: 'a'.repeat(121), slug: 'acme', timeZone: 'UTC' },
    },
    { name: 'an uppercase slug', input: { name: 'Acme', slug: 'Acme', timeZone: 'UTC' } },
    {
      name: 'a slug with a leading hyphen',
      input: { name: 'Acme', slug: '-acme', timeZone: 'UTC' },
    },
    { name: 'a 64-character slug', input: { name: 'Acme', slug: 'a'.repeat(64), timeZone: 'UTC' } },
    {
      name: 'an unknown time zone',
      input: { name: 'Acme', slug: 'acme', timeZone: 'Mars/Olympus' },
    },
    {
      name: 'a non-canonical time zone spelling',
      input: { name: 'Acme', slug: 'acme', timeZone: 'europe/london' },
    },
    {
      name: 'an upper-case time zone',
      input: { name: 'Acme', slug: 'acme', timeZone: 'EUROPE/LONDON' },
    },
    {
      name: 'an extra property',
      input: { name: 'Acme', slug: 'acme', timeZone: 'UTC', plan: 'pro' },
    },
  ])('rejects $name', ({ input }) => {
    expect(() => parseNewTenant(input)).toThrow(ValidationError);
  });
});
