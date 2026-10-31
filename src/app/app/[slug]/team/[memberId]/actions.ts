'use server';

import {
  addAvailabilityException,
  deleteAvailabilityException,
  MAX_BREAKS_PER_DAY,
  MAX_RANGES_PER_DAY,
  removeDailyCapacity,
  replaceWorkingHours,
  setDailyCapacity,
  setServiceAreas,
  setStaffServices,
  setTeamMemberActive,
  updateTeamMember,
  WEEKDAYS,
} from '@/modules/booking';
import { type TenantTx } from '@/modules/tenancy';

import { readString } from '../../../../_lib/form-errors';
import { type FormState, runForm } from '../../../../_lib/form-state';
import { getTenancy } from '../../../../_lib/tenancy';
import { authoriseAction } from '../../_lib/workspace';

/**
 * One helper for every action on a team member's page: re-authorise the slug (actions never trust
 * the form's tenant), run the command in the tenant, refresh the page and return the outcome as
 * form state.
 */
async function onMember(
  previous: FormState,
  formData: FormData,
  ok: string,
  command: (tx: TenantTx, memberId: string) => Promise<unknown>,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const memberId = readString(formData, 'memberId');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) => command(tx, memberId));
      return ok;
    },
    { revalidate: [`/app/${slug}/team/${memberId}`, `/app/${slug}/team`] },
  );
}

export async function updateMemberAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return onMember(previous, formData, 'Saved.', (tx, id) =>
    updateTeamMember(tx, id, {
      displayName: readString(formData, 'displayName'),
      membershipId: readString(formData, 'membershipId'),
    }),
  );
}

export async function setActiveAction(previous: FormState, formData: FormData): Promise<FormState> {
  const active = readString(formData, 'active') === 'true';
  return onMember(previous, formData, active ? 'Reactivated.' : 'Deactivated.', (tx, id) =>
    setTeamMemberActive(tx, id, active),
  );
}

export async function setServicesAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const serviceIds = formData.getAll('serviceIds').filter((value) => typeof value === 'string');
  return onMember(previous, formData, 'Services saved.', (tx, id) =>
    setStaffServices(tx, id, { serviceIds }),
  );
}

/**
 * The weekly editor posts `days.<weekday>.ranges.<n>.start` and the like for every row it shows
 * (all stored rows, never fewer); rebuild the nesting up to the domain maximum.
 */
export async function setHoursAction(previous: FormState, formData: FormData): Promise<FormState> {
  const locationId = readString(formData, 'locationId');
  const days: Record<string, { ranges: object[]; breaks: object[] }> = {};
  for (const weekday of WEEKDAYS) {
    const pairs = (kind: 'ranges' | 'breaks', count: number) =>
      Array.from({ length: count }, (_, index) => ({
        start: readString(formData, `days.${String(weekday)}.${kind}.${String(index)}.start`),
        end: readString(formData, `days.${String(weekday)}.${kind}.${String(index)}.end`),
      }));
    days[String(weekday)] = {
      ranges: pairs('ranges', MAX_RANGES_PER_DAY),
      breaks: pairs('breaks', MAX_BREAKS_PER_DAY),
    };
  }
  return onMember(previous, formData, 'Working hours saved.', (tx, id) =>
    replaceWorkingHours(tx, id, locationId, { days }),
  );
}

export async function addTimeOffAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return onMember(previous, formData, 'Time off added.', (tx, id) =>
    addAvailabilityException(tx, {
      kind: 'time_off',
      teamMemberId: id,
      locationId: readString(formData, 'locationId'),
      startsAt: readString(formData, 'startsAt'),
      endsAt: readString(formData, 'endsAt'),
    }),
  );
}

export async function deleteTimeOffAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return onMember(previous, formData, 'Time off removed.', (tx) =>
    deleteAvailabilityException(tx, readString(formData, 'exceptionId')),
  );
}

export async function setAreasAction(previous: FormState, formData: FormData): Promise<FormState> {
  return onMember(previous, formData, 'Service areas saved.', (tx, id) =>
    setServiceAreas(tx, id, {
      districts: readString(formData, 'districts'),
      travelBeforeMinutes: readString(formData, 'travelBeforeMinutes'),
      travelAfterMinutes: readString(formData, 'travelAfterMinutes'),
    }),
  );
}

export async function setCapacityAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return onMember(previous, formData, 'Daily capacity saved.', (tx, id) =>
    setDailyCapacity(tx, id, { maxEventsPerDate: readString(formData, 'maxEventsPerDate') }),
  );
}

export async function removeCapacityAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return onMember(previous, formData, 'Daily capacity removed.', (tx, id) =>
    removeDailyCapacity(tx, id),
  );
}
