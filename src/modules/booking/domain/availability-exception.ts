import { z } from 'zod';

import { ValidationError } from '@/shared/kernel/validation-error';

import { parseLocalDateTime, wallTimeToInstant } from './wall-clock';

/**
 * Exceptions to the weekly rules (docs/architecture.md §6 step 2): a team member's time off, or a
 * location closed for everyone. Entered as local date-times in the location's zone and stored as
 * instants, because an exception is a specific stretch of time, not a repeating rule.
 */
export const EXCEPTION_KINDS = ['time_off', 'closure'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** A year is the longest single exception; longer absences are entered in parts. */
export const MAX_EXCEPTION_DAYS = 366;

export const exceptionInputSchema = z.strictObject({
  kind: z.enum(EXCEPTION_KINDS, 'time off or closure'),
  /** Required for time off, absent for a closure. */
  teamMemberId: z
    .union([z.literal(''), z.null(), z.uuid('choose a team member')])
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value)),
  locationId: z.uuid('choose a location'),
  /** "YYYY-MM-DDTHH:MM" in the location's zone. */
  startsAt: z.string(),
  endsAt: z.string(),
});

export interface ExceptionInput {
  readonly kind: ExceptionKind;
  readonly teamMemberId: string | null;
  readonly locationId: string;
}

export interface ResolvedException extends ExceptionInput {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** First pass: shape only. The application looks up the location's zone, then calls `resolve`. */
export function parseExceptionInput(input: unknown): ExceptionInput & {
  readonly startsAt: string;
  readonly endsAt: string;
} {
  const result = exceptionInputSchema.safeParse(input);
  const issues: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  const fail = (path: string, message: string) => {
    issues.push(`${path}: ${message}`);
    (fieldErrors[path] ??= []).push(message);
  };
  if (!result.success) {
    for (const issue of result.error.issues) {
      fail(issue.path.map(String).join('.') || 'exception', issue.message);
    }
    throw new ValidationError('time off or closure', issues, fieldErrors);
  }
  const data = result.data;
  if (data.kind === 'time_off' && data.teamMemberId === null) {
    fail('teamMemberId', 'time off needs a team member');
  }
  if (data.kind === 'closure' && data.teamMemberId !== null) {
    fail('teamMemberId', 'a closure applies to everyone at the location');
  }
  if (issues.length > 0) {
    throw new ValidationError('time off or closure', issues, fieldErrors);
  }
  return data;
}

/**
 * Resolves the local start and end in `zone`. A local time that does not exist (inside a
 * spring-forward gap) is refused rather than guessed; an ambiguous one takes the earlier instant.
 */
export function resolveException(
  input: ExceptionInput & { readonly startsAt: string; readonly endsAt: string },
  zone: string,
): ResolvedException {
  const issues: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  const fail = (path: string, message: string) => {
    issues.push(`${path}: ${message}`);
    (fieldErrors[path] ??= []).push(message);
  };
  const instantOf = (field: 'startsAt' | 'endsAt'): Date | null => {
    const local = parseLocalDateTime(input[field]);
    if (local === null) {
      fail(field, 'a date and time');
      return null;
    }
    const instant = wallTimeToInstant(local.date, local.minutes, zone);
    if (instant === null) {
      fail(field, `does not exist in ${zone} (the clocks go forward then)`);
    }
    return instant;
  };
  const startsAt = instantOf('startsAt');
  const endsAt = instantOf('endsAt');
  if (startsAt !== null && endsAt !== null) {
    if (endsAt <= startsAt) {
      fail('endsAt', 'must be after the start');
    } else if (endsAt.getTime() - startsAt.getTime() > MAX_EXCEPTION_DAYS * 24 * 3600_000) {
      fail('endsAt', `at most ${String(MAX_EXCEPTION_DAYS)} days after the start`);
    }
  }
  if (issues.length > 0 || startsAt === null || endsAt === null) {
    throw new ValidationError('time off or closure', issues, fieldErrors);
  }
  return {
    kind: input.kind,
    teamMemberId: input.teamMemberId,
    locationId: input.locationId,
    startsAt,
    endsAt,
  };
}
