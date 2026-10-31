'use server';

import { redirect } from 'next/navigation';

import {
  KNOWN_FEATURE_FLAGS,
  toggleFeatureFlag,
  updateBusinessSettings,
  ValidationError,
} from '@/modules/tenancy';

import { formMessage, readString } from '../../../_lib/form-errors';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  let message = 'Settings saved.';
  let isError = false;
  try {
    await getTenancy().withTenant(ctx, (tx) =>
      updateBusinessSettings(tx, {
        name: readString(formData, 'name'),
        businessType: readString(formData, 'businessType'),
        timeZone: readString(formData, 'timeZone'),
      }),
    );
  } catch (error) {
    message = formMessage(error);
    isError = true;
  }
  redirect(`/app/${slug}/settings?${isError ? 'error' : 'notice'}=${encodeURIComponent(message)}`);
}

export async function toggleFlagAction(formData: FormData): Promise<void> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  const flag = readString(formData, 'flag');
  const enabled = readString(formData, 'enabled') === 'true';
  let message: string;
  let isError = false;
  try {
    // The settings page offers the known flags only; the action enforces the same list, and
    // only a known flag name can ever appear in the redirect URL.
    if (!(KNOWN_FEATURE_FLAGS as readonly string[]).includes(flag)) {
      throw new ValidationError('feature flag', ['flag: not a flag this page can change']);
    }
    await getTenancy().withTenant(ctx, (tx) => toggleFeatureFlag(tx, flag, enabled));
    message = `${flag} turned ${enabled ? 'on' : 'off'}.`;
  } catch (error) {
    message = formMessage(error);
    isError = true;
  }
  redirect(`/app/${slug}/settings?${isError ? 'error' : 'notice'}=${encodeURIComponent(message)}`);
}
