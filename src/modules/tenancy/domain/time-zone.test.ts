import { describe, expect, it } from 'vitest';

import { canonicalTimeZone, ICU_LEGACY_TO_IANA, isIanaTimeZone } from './time-zone';

/** The rule in docs/adr/ADR-003-time-zones.md, case by case. */
describe('canonicalTimeZone', () => {
  it.each([
    'Europe/London',
    'America/New_York',
    'America/Port-au-Prince',
    'Antarctica/DumontDUrville',
    'Africa/Johannesburg',
    'UTC',
  ])('keeps the canonical name %s unchanged', (zone) => {
    expect(canonicalTimeZone(zone)).toBe(zone);
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each([
    ['Asia/Kolkata', 'Asia/Calcutta'],
    ['Europe/Kyiv', 'Europe/Kiev'],
    ['Asia/Ho_Chi_Minh', 'Asia/Saigon'],
    ['Asia/Yangon', 'Asia/Rangoon'],
    ['Asia/Kathmandu', 'Asia/Katmandu'],
    ['Pacific/Kanton', 'Pacific/Enderbury'],
    ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires'],
    ['America/Indiana/Indianapolis', 'America/Indianapolis'],
    ['Atlantic/Faroe', 'Atlantic/Faeroe'],
    ['America/Nuuk', 'America/Godthab'],
  ])('stores the modern IANA name %s for both spellings (legacy %s)', (modern, legacy) => {
    expect(canonicalTimeZone(modern)).toBe(modern);
    expect(canonicalTimeZone(legacy)).toBe(modern);
    expect(canonicalTimeZone(legacy.toLowerCase())).toBe(modern);
    expect(isIanaTimeZone(legacy)).toBe(false);
  });

  it('maps only to names Intl knows, and never stores a legacy spelling', () => {
    for (const [legacy, modern] of Object.entries(ICU_LEGACY_TO_IANA)) {
      expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: modern })).not.toThrow();
      expect(canonicalTimeZone(legacy)).toBe(modern);
    }
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      const stored = canonicalTimeZone(zone);
      expect(stored, zone).not.toBeNull();
      expect(
        Object.hasOwn(ICU_LEGACY_TO_IANA, stored ?? ''),
        `${zone} stored as ${stored ?? ''}`,
      ).toBe(false);
    }
  });

  it.each([
    ['europe/london', 'Europe/London'],
    ['EUROPE/LONDON', 'Europe/London'],
    ['America/New_york', 'America/New_York'],
    ['  Europe/London  ', 'Europe/London'],
  ])('repairs the case of %s to %s', (input, expected) => {
    expect(canonicalTimeZone(input)).toBe(expected);
  });

  it.each([
    ['GB', 'Europe/London'],
    ['GB-Eire', 'Europe/London'],
    ['US/Eastern', 'America/New_York'],
    ['Australia/ACT', 'Australia/Sydney'],
    ['Japan', 'Asia/Tokyo'],
  ])('converts the legacy alias %s to %s', (input, expected) => {
    expect(canonicalTimeZone(input)).toBe(expected);
    expect(isIanaTimeZone(input)).toBe(false);
  });

  it.each(['utc', 'Utc', 'GMT', 'gmt', 'Zulu', 'Etc/UTC', 'Etc/GMT', 'Etc/Universal', 'UCT'])(
    'stores %s as UTC',
    (input) => {
      expect(canonicalTimeZone(input)).toBe('UTC');
    },
  );

  it.each([
    'EST',
    'est',
    'MST',
    'HST',
    'CET',
    'MET',
    'WET',
    'EET',
    'EST5EDT',
    'CST6CDT',
    'MST7MDT',
    'PST8PDT',
  ])('rejects the abbreviation zone %s instead of guessing a city', (input) => {
    expect(canonicalTimeZone(input)).toBeNull();
  });

  it.each(['Etc/GMT+1', 'Etc/GMT-10', 'etc/gmt+1'])('rejects the fixed-offset zone %s', (input) => {
    expect(canonicalTimeZone(input)).toBeNull();
  });

  it.each(['', '   ', 'Mars/Olympus', 'Europe/Atlantis', 'GMT+1 (London)', '+01:00', 'London'])(
    'rejects %s as unknown',
    (input) => {
      expect(canonicalTimeZone(input)).toBeNull();
      expect(isIanaTimeZone(input)).toBe(false);
    },
  );

  it('is idempotent: applying the rule to its own output changes nothing', () => {
    for (const input of [
      'europe/london',
      'GB',
      'utc',
      'Asia/Kolkata',
      'US/Eastern',
      'Europe/Kyiv',
    ]) {
      const once = canonicalTimeZone(input);
      expect(once).not.toBeNull();
      expect(canonicalTimeZone(once ?? '')).toBe(once);
    }
  });

  it('produces only Area/Location names or UTC for every zone Intl supports', () => {
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      const stored = canonicalTimeZone(zone);
      expect(stored, zone).not.toBeNull();
      expect(stored, zone).toMatch(/^(?:UTC|[A-Z][a-z]+(?:\/[A-Za-z0-9_+-]+)+)$/);
    }
  });
});
