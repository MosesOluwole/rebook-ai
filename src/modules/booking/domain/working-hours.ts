import { z } from 'zod';

import { ValidationError } from '@/shared/kernel/validation-error';

import {
  isoWeekday,
  type LocalDate,
  parseLocalDate,
  wallTimeToInstantOrAfterGap,
} from './wall-clock';

/**
 * Weekly working hours: wall-clock rules per team member and location (docs/architecture.md §6,
 * docs/phases.md Phase 3). "Monday 09:00–17:00" is stored as exactly that, never as instants, and
 * becomes UTC only for a given date in the location's zone (`resolveWorkingDay`). Breaks belong
 * to the range that contains them.
 */

/** ISO weekdays: 1 = Monday … 7 = Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export const MAX_RANGES_PER_DAY = 4;
export const MAX_BREAKS_PER_DAY = 4;

const END_OF_DAY = 24 * 60;

/** "HH:MM" → minutes past midnight. "24:00" is accepted only where `allowEndOfDay`. */
export function parseTimeOfDay(value: string, allowEndOfDay = false): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours === 24 && minutes === 0 && allowEndOfDay) {
    return END_OF_DAY;
  }
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

/** Minutes past midnight → "HH:MM" (1440 → "24:00"). */
export function formatTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export interface TimeRange {
  /** Minutes past local midnight. */
  readonly start: number;
  /** Minutes past local midnight, after `start`; 1440 is midnight at the end of the day. */
  readonly end: number;
}

export interface WorkingRange extends TimeRange {
  readonly weekday: Weekday;
  readonly breaks: readonly TimeRange[];
}

const timeField = z.string().default('');
const pairSchema = z.strictObject({ start: timeField, end: timeField });
const daySchema = z.strictObject({
  ranges: z.array(pairSchema).max(MAX_RANGES_PER_DAY).default([]),
  breaks: z.array(pairSchema).max(MAX_BREAKS_PER_DAY).default([]),
});

/**
 * The form shape: per weekday, working ranges and breaks as "HH:MM" pairs. A pair left entirely
 * blank is ignored; a half-filled pair is an error. Field paths in errors match the input
 * (`days.1.ranges.0.end`), so a form can show each message beside its input.
 */
export const weeklyScheduleInputSchema = z.strictObject({
  days: z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), daySchema),
});

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Validates one location's weekly schedule for one team member and returns its ranges, each with
 * the breaks inside it. Refuses, with a field path per problem: malformed or half-filled times,
 * a start not before its end, ranges overlapping on the same day, a break outside every range of
 * its day, and breaks overlapping each other.
 */
export function parseWeeklySchedule(input: unknown): WorkingRange[] {
  const parsed = weeklyScheduleInputSchema.safeParse(input);
  const issues: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  const fail = (path: string, message: string) => {
    issues.push(`${path}: ${message}`);
    (fieldErrors[path] ??= []).push(message);
  };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fail(issue.path.map(String).join('.') || 'days', issue.message);
    }
    throw new ValidationError('working hours', issues, fieldErrors);
  }

  const result: WorkingRange[] = [];
  for (const weekday of WEEKDAYS) {
    const day = parsed.data.days[String(weekday) as `${Weekday}`];
    if (day === undefined) {
      continue;
    }
    const prefix = `days.${String(weekday)}`;
    const readPairs = (pairs: readonly { start: string; end: string }[], kind: string) => {
      const ranges: { range: TimeRange; path: string }[] = [];
      pairs.forEach((pair, index) => {
        const path = `${prefix}.${kind}.${String(index)}`;
        if (pair.start.trim() === '' && pair.end.trim() === '') {
          return;
        }
        const start = parseTimeOfDay(pair.start);
        const end = parseTimeOfDay(pair.end, true);
        if (start === null) {
          fail(`${path}.start`, 'a time such as 09:00');
        }
        if (end === null) {
          fail(`${path}.end`, 'a time such as 17:00 (24:00 for midnight)');
        }
        if (start === null || end === null) {
          return;
        }
        if (start >= end) {
          fail(`${path}.end`, 'must be after the start');
          return;
        }
        ranges.push({ range: { start, end }, path });
      });
      return ranges;
    };

    const ranges = readPairs(day.ranges, 'ranges');
    const breaks = readPairs(day.breaks, 'breaks');

    ranges.forEach((current, index) => {
      const earlier = ranges.slice(0, index).find((other) => overlaps(other.range, current.range));
      if (earlier !== undefined) {
        fail(
          `${current.path}.start`,
          `overlaps another working range on ${WEEKDAY_NAMES[weekday]}`,
        );
      }
    });
    breaks.forEach((current, index) => {
      if (
        !ranges.some(
          ({ range }) => range.start <= current.range.start && current.range.end <= range.end,
        )
      ) {
        fail(`${current.path}.start`, 'must fall inside a working range of the same day');
      }
      if (breaks.slice(0, index).some((other) => overlaps(other.range, current.range))) {
        fail(`${current.path}.start`, 'overlaps another break');
      }
    });

    for (const { range } of ranges) {
      result.push({
        weekday,
        start: range.start,
        end: range.end,
        breaks: breaks
          .map(({ range: b }) => b)
          .filter((b) => range.start <= b.start && b.end <= range.end)
          .sort((x, y) => x.start - y.start),
      });
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('working hours', issues, fieldErrors);
  }
  return result.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
}

export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The working intervals of one local date as UTC instants, breaks removed, using the location's
 * IANA zone for that date (docs/architecture.md §6 step 1). An edge inside a spring-forward gap
 * moves to the end of the gap; an edge inside an autumn overlap takes the earlier instant. An
 * interval that collapses to nothing (entirely inside a gap) is dropped.
 */
export function resolveWorkingDay(
  schedule: readonly WorkingRange[],
  date: LocalDate,
  zone: string,
): Interval[] {
  const parts = parseLocalDate(date);
  if (parts === null) {
    throw new ValidationError('date', [`date: expected YYYY-MM-DD`], {
      date: ['expected YYYY-MM-DD'],
    });
  }
  const weekday = isoWeekday(parts);
  const intervals: Interval[] = [];
  for (const range of schedule.filter((r) => r.weekday === weekday)) {
    let cursor = range.start;
    const pieces: TimeRange[] = [];
    for (const pause of range.breaks) {
      if (pause.start > cursor) {
        pieces.push({ start: cursor, end: pause.start });
      }
      cursor = Math.max(cursor, pause.end);
    }
    if (cursor < range.end) {
      pieces.push({ start: cursor, end: range.end });
    }
    for (const piece of pieces) {
      const start = wallTimeToInstantOrAfterGap(parts, piece.start, zone);
      const end = wallTimeToInstantOrAfterGap(parts, piece.end, zone);
      if (start < end) {
        intervals.push({ start, end });
      }
    }
  }
  return intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
}
