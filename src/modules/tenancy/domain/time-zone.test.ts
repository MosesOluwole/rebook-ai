import { describe, expect, it } from 'vitest';

import { isIanaTimeZone } from './time-zone';

describe('isIanaTimeZone', () => {
  it.each([
    'Europe/London',
    'Asia/Kolkata',
    'Asia/Calcutta',
    'Europe/Kyiv',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'America/Port-au-Prince',
    'Antarctica/DumontDUrville',
    'Etc/UTC',
    'Etc/GMT+1',
    'UTC',
  ])('accepts %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each([
    '',
    'europe/london',
    'EUROPE/LONDON',
    'utc',
    'EST',
    'GB',
    'GMT',
    'Mars/Olympus',
    'Europe/Atlantis',
    'GMT+1 (London)',
    '+01:00',
  ])('rejects %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });
});
