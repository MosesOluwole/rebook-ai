import {
  assertPermission,
  requireId,
  EXCLUSION_VIOLATION,
  locationsRepository,
  NotFoundError,
  sqlStateOf,
  type TenantTx,
  ValidationError,
  violatedConstraintOf,
} from '@/modules/tenancy';
import { type Clock } from '@/shared/kernel/clock';

import { parseExceptionInput, resolveException } from '../domain/availability-exception';
import { type LocalDate } from '../domain/wall-clock';
import {
  type Interval,
  parseWeeklySchedule,
  resolveWorkingDay,
  type WorkingRange,
} from '../domain/working-hours';
import {
  type AvailabilityException,
  exceptionsRepository,
  type StoredWorkingRange,
  teamMembersRepository,
  workingHoursRepository,
} from '../infrastructure/repositories';

export type { AvailabilityException, StoredWorkingRange };

const OTHER_LOCATION =
  'overlaps working hours this team member already has at another location on the same day';

/**
 * Owner-only. Replaces one team member's weekly hours (with breaks) at one location. The rules
 * are stored as wall-clock values; the location's zone applies when they are resolved for a date.
 * Overlaps within the submitted week are field errors from the domain; an overlap with the same
 * person's hours at another location is refused by the exclusion constraint working_hours_no_overlap
 * and reported as a form-level error.
 */
export async function replaceWorkingHours(
  tx: TenantTx,
  teamMemberId: string,
  locationId: string,
  input: unknown,
): Promise<WorkingRange[]> {
  assertPermission(tx, 'schedules.manage');
  const ranges = parseWeeklySchedule(input);
  if ((await teamMembersRepository.lock(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  if ((await locationsRepository.findById(tx, requireId(locationId))) === null) {
    throw new NotFoundError();
  }
  try {
    await workingHoursRepository.replace(tx, teamMemberId, locationId, ranges);
  } catch (error) {
    if (
      sqlStateOf(error) === EXCLUSION_VIOLATION &&
      violatedConstraintOf(error) === 'working_hours_no_overlap'
    ) {
      throw new ValidationError('working hours', [`days: ${OTHER_LOCATION}`], {
        '': [OTHER_LOCATION],
      });
    }
    throw error;
  }
  return ranges;
}

export async function getWorkingHours(
  tx: TenantTx,
  teamMemberId: string,
): Promise<StoredWorkingRange[]> {
  assertPermission(tx, 'workspace.view');
  if ((await teamMembersRepository.findById(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  return workingHoursRepository.listForTeamMember(tx, teamMemberId);
}

/**
 * The stored rules of one team member at one location, resolved for a local date in that
 * location's IANA zone: UTC intervals with breaks removed (docs/architecture.md §6 step 1).
 */
export async function workingIntervalsOn(
  tx: TenantTx,
  teamMemberId: string,
  locationId: string,
  date: LocalDate,
): Promise<Interval[]> {
  assertPermission(tx, 'workspace.view');
  const location = await locationsRepository.findById(tx, requireId(locationId));
  if (location === null) {
    throw new NotFoundError();
  }
  const ranges = (await getWorkingHours(tx, teamMemberId)).filter(
    (range) => range.locationId === locationId,
  );
  return resolveWorkingDay(ranges, date, location.timeZone);
}

/**
 * Owner-only. Time off for a team member or a closure of a location, entered in the location's
 * local time and stored as instants.
 */
export async function addAvailabilityException(
  tx: TenantTx,
  input: unknown,
): Promise<AvailabilityException> {
  assertPermission(tx, 'schedules.manage');
  const parsed = parseExceptionInput(input);
  const location = await locationsRepository.findById(tx, parsed.locationId);
  if (location === null) {
    throw new NotFoundError();
  }
  if (
    parsed.teamMemberId !== null &&
    (await teamMembersRepository.findById(tx, parsed.teamMemberId)) === null
  ) {
    throw new NotFoundError();
  }
  return exceptionsRepository.insert(tx, resolveException(parsed, location.timeZone));
}

export async function deleteAvailabilityException(tx: TenantTx, id: string): Promise<void> {
  assertPermission(tx, 'schedules.manage');
  if (!(await exceptionsRepository.delete(tx, requireId(id)))) {
    throw new NotFoundError();
  }
}

/** Time off and closures that have not ended yet, earliest first. */
export function listCurrentExceptions(
  tx: TenantTx,
  clock: Clock,
): Promise<AvailabilityException[]> {
  assertPermission(tx, 'workspace.view');
  return exceptionsRepository.listCurrent(tx, clock.now());
}
