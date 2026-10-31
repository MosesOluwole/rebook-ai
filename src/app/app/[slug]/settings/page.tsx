import {
  BUSINESS_TYPES,
  can,
  isFeatureEnabled,
  KNOWN_FEATURE_FLAGS,
  terminologyFor,
} from '@/modules/tenancy';

import { getTenancy } from '../../../_lib/tenancy';
import { timeZoneOptions } from '../../../_lib/time-zones';
import { loadWorkspace } from '../_lib/workspace';
import { toggleFlagAction, updateSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function SettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<{
    readonly notice?: string | string[];
    readonly error?: string | string[];
  }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { ctx, tenant } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'settings.update');
  const flags = await getTenancy().withTenant(ctx, async (tx) =>
    Promise.all(
      KNOWN_FEATURE_FLAGS.map(async (flag) => ({
        flag,
        enabled: await isFeatureEnabled(tx, flag),
      })),
    ),
  );
  const notice = first(query.notice);
  const error = first(query.error);

  return (
    <>
      <h1>Settings</h1>
      {notice !== undefined && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!isOwner && <p className="muted">Only an owner can change these settings.</p>}

      <section className="card" aria-labelledby="business-heading">
        <h2 id="business-heading">Business</h2>
        <form className="stack" action={updateSettingsAction}>
          <input type="hidden" name="slug" value={slug} />
          <label>
            Name
            <input
              type="text"
              name="name"
              defaultValue={tenant.name}
              required
              maxLength={120}
              disabled={!isOwner}
            />
          </label>
          <fieldset disabled={!isOwner}>
            <legend>Business type</legend>
            {BUSINESS_TYPES.map((type) => (
              <label key={type}>
                <input
                  type="radio"
                  name="businessType"
                  value={type}
                  defaultChecked={type === tenant.businessType}
                />
                <span>{terminologyFor(type).label}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Time zone
            <select name="timeZone" defaultValue={tenant.timeZone} disabled={!isOwner}>
              {timeZoneOptions().map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Address: <code>/app/{tenant.slug}</code> (cannot be changed).
          </p>
          {isOwner && <button type="submit">Save settings</button>}
        </form>
      </section>

      <section className="card" aria-labelledby="flags-heading">
        <h2 id="flags-heading">Feature flags</h2>
        <table>
          <thead>
            <tr>
              <th>Flag</th>
              <th>State</th>
              {isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {flags.map(({ flag, enabled }) => (
              <tr key={flag}>
                <td>
                  <code>{flag}</code>
                </td>
                <td data-testid={`flag-${flag}`}>{enabled ? 'on' : 'off'}</td>
                {isOwner && (
                  <td>
                    <form action={toggleFlagAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="flag" value={flag} />
                      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
                      <button type="submit" className="quiet">
                        Turn {enabled ? 'off' : 'on'}
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
