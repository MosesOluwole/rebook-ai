'use server';

import { redirect } from 'next/navigation';

import { readString } from '../_lib/form-errors';
import { failed, type FormState } from '../_lib/form-state';
import { actorFor, requireUser } from '../_lib/session';
import { getTenancy } from '../_lib/tenancy';

/** Creates the business for the signed-in user and lands them in it. */
export async function completeOnboardingAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser('/onboarding');
  let slug: string;
  try {
    const tenant = await getTenancy().completeOnboarding(
      {
        name: readString(formData, 'name'),
        businessType: readString(formData, 'businessType'),
        timeZone: readString(formData, 'timeZone'),
      },
      actorFor(user),
    );
    slug = tenant.slug;
  } catch (error) {
    return failed(previous, formData, error);
  }
  redirect(`/app/${slug}`);
}
