'use server';

import { redirect } from 'next/navigation';

import { formMessage, readString } from '../_lib/form-errors';
import { actorFor, requireUser } from '../_lib/session';
import { getTenancy } from '../_lib/tenancy';

/** Creates the business for the signed-in user and lands them in it. */
export async function completeOnboardingAction(formData: FormData): Promise<void> {
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
    redirect(`/onboarding?error=${encodeURIComponent(formMessage(error))}`);
  }
  redirect(`/app/${slug}`);
}
