import { BUSINESS_TYPES, terminologyFor } from '@/modules/tenancy';

import { signOut } from '../(auth)/actions';
import {
  ActionForm,
  CheckInput,
  FieldMessage,
  SelectInput,
  SubmitButton,
  TextInput,
} from '../_components/forms';
import { actorFor, requireUser } from '../_lib/session';
import { getTenancy } from '../_lib/tenancy';
import { timeZoneOptions } from '../_lib/time-zones';
import { completeOnboardingAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const user = await requireUser('/onboarding');
  const existing = await getTenancy().listMyTenants(actorFor(user));

  return (
    <main>
      <h1>{existing.length === 0 ? 'Set up your business' : 'Add another business'}</h1>
      {/* A div, not a p: a form inside a paragraph is invalid HTML and breaks hydration. */}
      <div className="muted switcher">
        <span>
          Signed in as {user.email}. {existing.length === 0 ? 'This takes a minute.' : ''}
        </span>
        <form action={signOut}>
          <button type="submit" className="quiet">
            Sign out
          </button>
        </form>
      </div>
      <ActionForm action={completeOnboardingAction} className="stack card" label="Create business">
        <TextInput
          name="name"
          label="Business name"
          required
          maxLength={120}
          autoComplete="organization"
        />
        <fieldset>
          <legend>What kind of business is it?</legend>
          {BUSINESS_TYPES.map((type, index) => {
            const words = terminologyFor(type);
            return (
              <CheckInput
                key={type}
                type="radio"
                name="businessType"
                value={type}
                defaultChecked={index === 0}
                required
                label={
                  <>
                    {words.label}
                    <span className="muted">
                      {' '}
                      ({words.clients}, {words.bookings})
                    </span>
                  </>
                }
              />
            );
          })}
          <FieldMessage name="businessType" />
        </fieldset>
        <SelectInput
          name="timeZone"
          label="Time zone"
          defaultValue="Europe/London"
          required
          options={timeZoneOptions().map((zone) => ({ value: zone, label: zone }))}
        />
        <div>
          <SubmitButton>Create business</SubmitButton>
        </div>
      </ActionForm>
    </main>
  );
}
