/**
 * Time zone rule (docs/adr/ADR-003-time-zones.md). Intl canonicalises; a small table then maps
 * ICU's legacy spellings to the current IANA names, so what is stored is the modern name. In
 * order:
 *
 * 1. Unknown to Intl → rejected (`Mars/Olympus`, `+01:00`, `London`).
 * 2. Resolves to UTC → stored as `UTC` (`utc`, `GMT`, `Zulu`, `Etc/UTC`).
 * 3. An abbreviation zone (`EST`, `CET`, `EST5EDT`, …) → rejected. tzdata links each to one city
 *    with that fixed offset (EST → America/Panama), which is almost never what the person typing
 *    "EST" means; they must pick a place.
 * 4. Otherwise → the zone Intl resolves it to, provided that is an Area/Location name
 *    (`europe/london` and `GB` → `Europe/London`, `America/New_york` → `America/New_York`,
 *    `US/Eastern` → `America/New_York`). Fixed-offset zones such as `Etc/GMT+1` resolve to
 *    themselves, fail the shape test and are rejected.
 * 5. ICU's canonical id is replaced by the current IANA name where they differ
 *    (`Asia/Calcutta` → `Asia/Kolkata`, `Europe/Kiev` → `Europe/Kyiv`, …), so both spellings of a
 *    renamed zone store the modern one.
 *
 * Every output passes the database CHECK `rebook.is_time_zone()`;
 * tests/integration/tenancy/tenant-input-boundary.test.ts proves it for every zone Intl supports.
 */
const AREA_LOCATION = /^[A-Z][a-z]+(?:\/[A-Z][A-Za-z0-9_+-]*[a-z][A-Za-z0-9_+-]*)+$/;

/** tzdata's offset-rule zones: the only IANA names that are neither places nor UTC. */
const ABBREVIATION_ZONES: ReadonlySet<string> = new Set([
  'EST',
  'MST',
  'HST',
  'EST5EDT',
  'CST6CDT',
  'MST7MDT',
  'PST8PDT',
  'CET',
  'MET',
  'WET',
  'EET',
]);

/**
 * ICU canonical id → current IANA name, for the zones where ICU (78.3 on Node 24.22) still
 * prefers tzdata's backward-link spelling. Built from what `Intl.DateTimeFormat` returns for the
 * modern names; `pnpm test` fails if a mapped name is unknown to Intl, and the integration suite
 * fails if one is unknown to Postgres. Add an entry when a newer ICU renames something.
 */
export const ICU_LEGACY_TO_IANA: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

function resolveWithIntl(value: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The value to store for a user-supplied time zone, or null when the rule rejects it. */
export function canonicalTimeZone(input: string): string | null {
  const value = input.trim();
  if (value === '') {
    return null;
  }
  const resolved = resolveWithIntl(value);
  if (resolved === null) {
    return null;
  }
  if (resolved === 'UTC') {
    return 'UTC';
  }
  if (ABBREVIATION_ZONES.has(value.toUpperCase())) {
    return null;
  }
  if (!AREA_LOCATION.test(resolved)) {
    return null;
  }
  return ICU_LEGACY_TO_IANA[resolved] ?? resolved;
}

/** True when the value is already in its stored form: the rule would return it unchanged. */
export function isIanaTimeZone(value: string): boolean {
  return canonicalTimeZone(value) === value;
}

export const TIME_ZONE_MESSAGE = 'must be an IANA time zone name such as Europe/London';
