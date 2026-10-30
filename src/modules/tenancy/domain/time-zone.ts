/**
 * Accepts IANA time zone names in their exact spelling (`Europe/London`, `Asia/Kolkata`,
 * `America/Argentina/Buenos_Aires`, `Etc/UTC`, `UTC`): the same strings the database CHECK
 * `rebook.is_time_zone()` accepts.
 *
 * Intl alone is not enough: it is case-insensitive, and ICU's `resolvedOptions().timeZone`
 * canonicalises to spellings that differ by ICU version (`Asia/Kolkata` → `Asia/Calcutta` on some
 * builds), so neither "Intl accepts it" nor "Intl echoes it" matches Postgres. The shape test keeps
 * the exact case and the Area/Location form; Intl then confirms the zone exists.
 */
const IANA_SHAPE =
  /^(?:UTC|Etc\/(?:UTC|GMT(?:[+-]\d{1,2})?)|[A-Z][a-z]+(?:\/[A-Z][A-Za-z0-9_+-]*[a-z][A-Za-z0-9_+-]*)+)$/;

export function isIanaTimeZone(value: string): boolean {
  if (!IANA_SHAPE.test(value)) {
    return false;
  }
  try {
    Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TIME_ZONE_MESSAGE = 'must be an IANA time zone name such as Europe/London';
