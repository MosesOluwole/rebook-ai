import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import { parseNewTenant, parseTenantSettings } from './tenant';

describe('parseNewTenant', () => {
  it('accepts a valid tenant and trims the name', () => {
    expect(
      parseNewTenant({
        name: '  Acme Events ',
        slug: 'acme-events',
        businessType: 'event_planner',
        timeZone: 'Europe/London',
      }),
    ).toEqual({
      name: 'Acme Events',
      slug: 'acme-events',
      businessType: 'event_planner',
      timeZone: 'Europe/London',
    });
  });

  it.each([
    ['europe/london', 'Europe/London'],
    ['GB', 'Europe/London'],
    ['utc', 'UTC'],
    ['US/Eastern', 'America/New_York'],
    ['America/New_york', 'America/New_York'],
  ])('canonicalises the time zone %s to %s before it is stored (ADR-003)', (input, stored) => {
    expect(
      parseNewTenant({ name: 'Acme', slug: 'acme', businessType: 'midwife', timeZone: input })
        .timeZone,
    ).toBe(stored);
  });

  const valid = { name: 'Acme', slug: 'acme', businessType: 'midwife', timeZone: 'UTC' };

  it.each([
    { name: 'an empty name', input: { ...valid, name: '  ' } },
    { name: 'a 121-character name', input: { ...valid, name: 'a'.repeat(121) } },
    { name: 'an uppercase slug', input: { ...valid, slug: 'Acme' } },
    { name: 'a slug with a leading hyphen', input: { ...valid, slug: '-acme' } },
    { name: 'a 64-character slug', input: { ...valid, slug: 'a'.repeat(64) } },
    { name: 'an unknown business type', input: { ...valid, businessType: 'salon' } },
    { name: 'a missing business type', input: { name: 'Acme', slug: 'acme', timeZone: 'UTC' } },
    { name: 'an unknown time zone', input: { ...valid, timeZone: 'Mars/Olympus' } },
    { name: 'an abbreviation time zone', input: { ...valid, timeZone: 'EST' } },
    { name: 'a fixed-offset time zone', input: { ...valid, timeZone: 'Etc/GMT+1' } },
    { name: 'an extra property', input: { ...valid, plan: 'pro' } },
  ])('rejects $name', ({ input }) => {
    expect(() => parseNewTenant(input)).toThrow(ValidationError);
  });

  it('names the field in the error', () => {
    expect(() => parseNewTenant({ ...valid, timeZone: 'EST' })).toThrow(
      /timeZone: must be an IANA time zone name/,
    );
  });
});

describe('parseTenantSettings', () => {
  it('accepts name, business type and time zone, and nothing else', () => {
    expect(
      parseTenantSettings({ name: ' Bloom ', businessType: 'other_timed', timeZone: 'gb' }),
    ).toEqual({ name: 'Bloom', businessType: 'other_timed', timeZone: 'Europe/London' });
    expect(() =>
      parseTenantSettings({
        name: 'Bloom',
        businessType: 'other_timed',
        timeZone: 'UTC',
        slug: 'x',
      }),
    ).toThrow(ValidationError);
  });
});
