import { BUSINESS_TYPES, terminologyFor } from '@/modules/tenancy';

import { signOut } from '../(auth)/actions';
import { actorFor, requireUser } from '../_lib/session';
import { getTenancy } from '../_lib/tenancy';
import { timeZoneOptions } from '../_lib/time-zones';
import { completeOnboardingAction } from './actions';

export const dynamic = 'force-dynamic';

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
}) {
  const user = await requireUser('/onboarding');
  const [params, existing] = await Promise.all([
    searchParams,
    getTenancy().listMyTenants(actorFor(user)),
  ]);
  const error = first(params.error);

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
      {error !== undefined && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form className="stack card" action={completeOnboardingAction}>
        <label>
          Business name
          <input type="text" name="name" required maxLength={120} autoComplete="organization" />
        </label>
        <fieldset>
          <legend>What kind of business is it?</legend>
          {BUSINESS_TYPES.map((type, index) => {
            const words = terminologyFor(type);
            return (
              <label key={type}>
                <input
                  type="radio"
                  name="businessType"
                  value={type}
                  defaultChecked={index === 0}
                  required
                />
                <span>
                  {words.label}
                  <span className="muted">
                    {' '}
                    ({words.clients}, {words.bookings})
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label>
          Time zone
          <select name="timeZone" defaultValue="Europe/London" required>
            {timeZoneOptions().map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Create business</button>
      </form>
    </main>
  );
}
