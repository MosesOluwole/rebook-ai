'use server';

import { businessTypeGuard } from '@/modules/crm';
import {
  KNOWN_FEATURE_FLAGS,
  toggleFeatureFlag,
  updateBusinessSettings,
  ValidationError,
} from '@/modules/tenancy';

import { readString } from '../../../_lib/form-errors';
import { type FormState, runForm } from '../../../_lib/form-state';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

export async function updateSettingsAction(
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
        updateBusinessSettings(
          tx,
          {
            name: readString(formData, 'name'),
            businessType: readString(formData, 'businessType'),
            timeZone: readString(formData, 'timeZone'),
          },
          businessTypeGuard,
        ),
      );
      return 'Settings saved.';
    },
    // The layout shows the name and the dashboard the business type's words.
    { revalidate: [`/app/${slug}`, `/app/${slug}/settings`] },
  );
}

export async function toggleFlagAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  const flag = readString(formData, 'flag');
  const enabled = readString(formData, 'enabled') === 'true';
  return runForm(
    previous,
    formData,
    async () => {
      // The settings page offers the known flags only; the action enforces the same list.
      if (!(KNOWN_FEATURE_FLAGS as readonly string[]).includes(flag)) {
        throw new ValidationError('feature flag', ['flag: not a flag this page can change']);
      }
      await getTenancy().withTenant(ctx, (tx) => toggleFeatureFlag(tx, flag, enabled));
      return `${flag} turned ${enabled ? 'on' : 'off'}.`;
    },
    { revalidate: [`/app/${slug}/settings`] },
  );
}
