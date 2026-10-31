import Link from 'next/link';

import { listCurrentExceptions, listTeamMembers } from '@/modules/booking';
import { can, listLocations } from '@/modules/tenancy';

import { getClock, getTenancy } from '../../../_lib/tenancy';
import { ActionForm, SelectInput, SubmitButton, TextInput } from '../../../_components/forms';
import { loadWorkspace } from '../_lib/workspace';
import { addClosureAction, deleteExceptionAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function TimeOffPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx, tenant } = await loadWorkspace(slug);
  const canSchedule = ctx.role !== null && can(ctx.role, 'schedules.manage');
  const { exceptions, locations, members } = await getTenancy().withTenant(ctx, async (tx) => ({
    exceptions: await listCurrentExceptions(tx, getClock()),
    locations: await listLocations(tx),
    members: await listTeamMembers(tx),
  }));
  const location = new Map(locations.map((l) => [l.id, l]));
  const memberName = new Map(members.map((m) => [m.id, m.displayName]));

  return (
    <>
      <h1>Time off and closures</h1>
      <p className="muted">
        Add a team member&apos;s time off from their page on the{' '}
        <Link href={`/app/${slug}/team`}>Team</Link> screen.
      </p>

      <section className="card" aria-labelledby="current-heading">
        <h2 id="current-heading">Current and upcoming</h2>
        {exceptions.length === 0 ? (
          <p className="muted">Nothing booked.</p>
        ) : (
          <ul className="plain">
            {exceptions.map((exception) => {
              const where = location.get(exception.locationId);
              const format = new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: where?.timeZone ?? tenant.timeZone,
              });
              return (
                <li key={exception.id}>
                  <strong>
                    {exception.teamMemberId === null
                      ? `${where?.name ?? 'Location'} closed`
                      : `${memberName.get(exception.teamMemberId) ?? 'Team member'} off`}
                  </strong>{' '}
                  {format.format(exception.startsAt)} – {format.format(exception.endsAt)}
                  {canSchedule && (
                    <ActionForm action={deleteExceptionAction} label="Remove">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="id" value={exception.id} />
                      <div>
                        <SubmitButton className="danger">Remove</SubmitButton>
                      </div>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canSchedule && (
        <section className="card" aria-labelledby="closure-heading">
          <h2 id="closure-heading">Close a location</h2>
          <ActionForm action={addClosureAction} label="Close a location">
            <input type="hidden" name="slug" value={slug} />
            <SelectInput
              name="locationId"
              label="Location (its time zone applies)"
              defaultValue={locations[0]?.id}
              options={locations.map((l) => ({ value: l.id, label: `${l.name} (${l.timeZone})` }))}
            />
            <div className="row">
              <TextInput type="datetime-local" name="startsAt" label="From" required />
              <TextInput type="datetime-local" name="endsAt" label="Until" required />
            </div>
            <div>
              <SubmitButton>Add closure</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
