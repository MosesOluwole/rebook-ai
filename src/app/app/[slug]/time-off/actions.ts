'use server';

import { addAvailabilityException, deleteAvailabilityException } from '@/modules/booking';

import { readString } from '../../../_lib/form-errors';
import { type FormState, runForm } from '../../../_lib/form-state';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

/** A location closed for everyone, in the location's local time. */
export async function addClosureAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) =>
        addAvailabilityException(tx, {
          kind: 'closure',
          locationId: readString(formData, 'locationId'),
          startsAt: readString(formData, 'startsAt'),
          endsAt: readString(formData, 'endsAt'),
        }),
      );
      return 'Closure added.';
    },
    { revalidate: [`/app/${slug}/time-off`] },
  );
}

export async function deleteExceptionAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) =>
        deleteAvailabilityException(tx, readString(formData, 'id')),
      );
      return 'Removed.';
    },
    { revalidate: [`/app/${slug}/time-off`] },
  );
}
