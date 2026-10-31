import { describe, expect, it } from 'vitest';

import { canonicalTimeZone, ICU_LEGACY_TO_IANA, isIanaTimeZone } from '@/modules/tenancy';

/**
 * Phase 2 follow-up 4: legacy spellings from tzdata's `backward` file (renamed zones, not the
 * 2022b pre-1970 merges) are never the stored form, whether typed by a user or returned by ICU.
 * The list is hard-coded on purpose so the test does not depend on the host's zoneinfo.
 */
const RENAMED: readonly (readonly [legacy: string, modern: string])[] = [
  ['Africa/Asmera', 'Africa/Asmara'],
  ['Africa/Timbuktu', 'Africa/Bamako'],
  ['America/Argentina/ComodRivadavia', 'America/Argentina/Catamarca'],
  ['America/Atka', 'America/Adak'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Ensenada', 'America/Tijuana'],
  ['America/Fort_Wayne', 'America/Indiana/Indianapolis'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Knox_IN', 'America/Indiana/Knox'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['America/Montreal', 'America/Toronto'],
  ['America/Nipigon', 'America/Toronto'],
  ['America/Pangnirtung', 'America/Iqaluit'],
  ['America/Porto_Acre', 'America/Rio_Branco'],
  ['America/Rosario', 'America/Argentina/Cordoba'],
  ['America/Santa_Isabel', 'America/Tijuana'],
  ['America/Shiprock', 'America/Denver'],
  ['America/Virgin', 'America/St_Thomas'],
  ['America/Yellowknife', 'America/Edmonton'],
  ['Antarctica/South_Pole', 'Antarctica/McMurdo'],
  ['Asia/Ashkhabad', 'Asia/Ashgabat'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Chongqing', 'Asia/Shanghai'],
  ['Asia/Chungking', 'Asia/Shanghai'],
  ['Asia/Dacca', 'Asia/Dhaka'],
  ['Asia/Harbin', 'Asia/Shanghai'],
  ['Asia/Istanbul', 'Europe/Istanbul'],
  ['Asia/Kashgar', 'Asia/Urumqi'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Macao', 'Asia/Macau'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Asia/Tel_Aviv', 'Asia/Jerusalem'],
  ['Asia/Thimbu', 'Asia/Thimphu'],
  ['Asia/Ujung_Pandang', 'Asia/Makassar'],
  ['Asia/Ulan_Bator', 'Asia/Ulaanbaatar'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Atlantic/Jan_Mayen', 'Arctic/Longyearbyen'],
  ['Europe/Belfast', 'Europe/London'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Europe/Nicosia', 'Asia/Nicosia'],
  ['Europe/Tiraspol', 'Europe/Chisinau'],
  ['Europe/Uzhgorod', 'Europe/Kyiv'],
  ['Europe/Zaporozhye', 'Europe/Kyiv'],
  ['Kwajalein', 'Pacific/Kwajalein'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Johnston', 'Pacific/Honolulu'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Samoa', 'Pacific/Pago_Pago'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
  ['Pacific/Yap', 'Pacific/Chuuk'],
];

const LEGACY = new Set(RENAMED.map(([legacy]) => legacy));

describe('legacy tzdata spellings are never stored', () => {
  it.each(RENAMED)(
    '%s is stored as %s, in any case, and is not already canonical',
    (legacy, modern) => {
      expect(canonicalTimeZone(legacy)).toBe(modern);
      expect(canonicalTimeZone(legacy.toLowerCase())).toBe(modern);
      expect(canonicalTimeZone(legacy.toUpperCase())).toBe(modern);
      expect(isIanaTimeZone(legacy)).toBe(false);
      expect(isIanaTimeZone(modern)).toBe(true);
    },
  );

  it('no zone Intl supports is stored under a legacy spelling', () => {
    const offenders = Intl.supportedValuesOf('timeZone')
      .map((zone) => [zone, canonicalTimeZone(zone)] as const)
      .filter(([, stored]) => stored === null || LEGACY.has(stored));
    expect(offenders).toEqual([]);
  });

  it('every ICU_LEGACY_TO_IANA key is a known legacy spelling and every value a modern name', () => {
    for (const [legacy, modern] of Object.entries(ICU_LEGACY_TO_IANA)) {
      expect(LEGACY.has(legacy), legacy).toBe(true);
      expect(LEGACY.has(modern), modern).toBe(false);
    }
  });
});
