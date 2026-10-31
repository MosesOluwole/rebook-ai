/**
 * Wall-clock time in a location's IANA zone, and the instants it resolves to
 * (docs/architecture.md §6 step 1, ADR-003). Rules are stored as wall-clock values (a weekday and
 * "09:00"); they become UTC instants only for a given local date, with the zone's rules for that
 * date. Node 24 has no Temporal, so the zone offset comes from Intl, which uses the same tzdata.
 *
 * Two DST cases, decided by the design:
 * - a wall time inside a spring-forward gap does not exist: `wallTimeToInstant` returns null;
 * - a wall time inside an autumn fall-back overlap exists twice: the earlier instant is used.
 */

/** A calendar date with no zone, "YYYY-MM-DD". */
export type LocalDate = string;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Parses "YYYY-MM-DD", rejecting impossible dates such as 2026-02-30. */
export function parseLocalDate(value: LocalDate): DateParts | null {
  const match = LOCAL_DATE.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: DateParts): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of an instant in `zone`, as milliseconds on a UTC-based scale. */
function wallReading(zone: string, instantMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** The zone's UTC offset at an instant, in milliseconds (positive east of Greenwich). */
function offsetAt(zone: string, instantMs: number): number {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return wallReading(zone, wholeSecond) - wholeSecond;
}

/**
 * The instant at which the wall clock in `zone` reads `minutes` past midnight of `date`
 * (`minutes` may be 1440: midnight at the end of the day). Null when that wall time falls in a
 * spring-forward gap; the earlier instant when it occurs twice.
 */
export function wallTimeToInstant(date: DateParts, minutes: number, zone: string): Date | null {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minutes * MINUTE_MS;
  // The offsets a day either side bracket any single transition near this wall time.
  const candidates = [wall - offsetAt(zone, wall - DAY_MS), wall - offsetAt(zone, wall + DAY_MS)];
  const valid = candidates.filter((instant) => wallReading(zone, instant) === wall);
  if (valid.length === 0) {
    return null;
  }
  return new Date(Math.min(...valid));
}

/**
 * Like `wallTimeToInstant`, but a wall time inside a gap moves to the first instant after the
 * gap (the clocks jumped over it). Used for the edges of a working range, which must still
 * resolve on a spring-forward day: a range from 01:30 on that day in Europe/London starts at
 * 02:00 BST, when the clocks read 02:00 again.
 */
export function wallTimeToInstantOrAfterGap(date: DateParts, minutes: number, zone: string): Date {
  const exact = wallTimeToInstant(date, minutes, zone);
  if (exact !== null) {
    return exact;
  }
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minutes * MINUTE_MS;
  // Before the transition the clock reads below `wall`, from the transition on it reads past it,
  // so "reads at least `wall`" is monotonic between the two candidate instants: binary search for
  // the first second where it holds. That second is the transition itself.
  const a = wall - offsetAt(zone, wall - DAY_MS);
  const b = wall - offsetAt(zone, wall + DAY_MS);
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (wallReading(zone, mid) >= wall) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return new Date(hi);
}

/** "YYYY-MM-DDTHH:MM" (an `<input type="datetime-local">` value) → date parts and minutes. */
export function parseLocalDateTime(
  value: string,
): { readonly date: DateParts; readonly minutes: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const date = parseLocalDate(match[1] ?? '');
  const [hours, minutes] = [Number(match[2]), Number(match[3])];
  if (date === null || hours > 23 || minutes > 59) {
    return null;
  }
  return { date, minutes: hours * 60 + minutes };
}
