import { tenantHasServices } from '@/modules/booking';
import {
  BUSINESS_TYPES,
  can,
  isFeatureEnabled,
  KNOWN_FEATURE_FLAGS,
  terminologyFor,
} from '@/modules/tenancy';

import {
  ActionForm,
  CheckInput,
  FieldMessage,
  SelectInput,
  SubmitButton,
  TextInput,
} from '../../../_components/forms';
import { getTenancy } from '../../../_lib/tenancy';
import { timeZoneOptions } from '../../../_lib/time-zones';
import { loadWorkspace } from '../_lib/workspace';
import { toggleFlagAction, updateSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx, tenant } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'settings.update');
  const { flags, typeLocked } = await getTenancy().withTenant(ctx, async (tx) => ({
    flags: await Promise.all(
      KNOWN_FEATURE_FLAGS.map(async (flag) => ({
        flag,
        enabled: await isFeatureEnabled(tx, flag),
      })),
    ),
    // Shown, not enforced, here: updateBusinessSettings refuses the change on the server.
    typeLocked: await tenantHasServices(tx),
  }));

  return (
    <>
      <h1>Settings</h1>
      {!isOwner && <p className="muted">Only an owner can change these settings.</p>}

      <section className="card" aria-labelledby="business-heading">
        <h2 id="business-heading">Business</h2>
        <ActionForm action={updateSettingsAction} label="Business settings">
          <input type="hidden" name="slug" value={slug} />
          <TextInput
            name="name"
            label="Name"
            defaultValue={tenant.name}
            required
            maxLength={120}
            disabled={!isOwner}
          />
          <fieldset disabled={!isOwner}>
            <legend>Business type</legend>
            {typeLocked && (
              <p className="muted" data-testid="business-type-locked">
                Locked: the business type cannot change once you have services.
              </p>
            )}
            {BUSINESS_TYPES.map((type) => (
              <CheckInput
                key={type}
                type="radio"
                name="businessType"
                value={type}
                label={terminologyFor(type).label}
                defaultChecked={type === tenant.businessType}
              />
            ))}
            <FieldMessage name="businessType" />
          </fieldset>
          <SelectInput
            name="timeZone"
            label="Time zone"
            defaultValue={tenant.timeZone}
            disabled={!isOwner}
            options={timeZoneOptions().map((zone) => ({ value: zone, label: zone }))}
          />
          <p className="muted">
            Address: <code>/app/{tenant.slug}</code> (cannot be changed).
          </p>
          {isOwner && (
            <div>
              <SubmitButton>Save settings</SubmitButton>
            </div>
          )}
        </ActionForm>
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
                    <ActionForm action={toggleFlagAction} className="inline-form">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="flag" value={flag} />
                      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
                      <SubmitButton className="quiet">Turn {enabled ? 'off' : 'on'}</SubmitButton>
                    </ActionForm>
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
