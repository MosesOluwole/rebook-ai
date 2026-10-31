import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  formatTimeOfDay,
  getDailyCapacity,
  getServiceAreas,
  getTeamMember,
  getWorkingHours,
  listCurrentExceptions,
  listServices,
  listTeamMembers,
  MAX_BREAKS_PER_DAY,
  MAX_EVENTS_PER_DATE,
  MAX_RANGES_PER_DAY,
  staffServiceIds,
  WEEKDAY_NAMES,
  WEEKDAYS,
} from '@/modules/booking';
import { can, isHealthBusiness, listLocations, listMembers } from '@/modules/tenancy';

import {
  ActionForm,
  CheckInput,
  SelectInput,
  SubmitButton,
  TextAreaInput,
  TextInput,
} from '../../../../_components/forms';
import { isNotFound } from '../../../../_lib/form-errors';
import { getClock, getTenancy } from '../../../../_lib/tenancy';
import { loadWorkspace } from '../../_lib/workspace';
import {
  addTimeOffAction,
  deleteTimeOffAction,
  removeCapacityAction,
  setActiveAction,
  setAreasAction,
  setCapacityAction,
  setHoursAction,
  setServicesAction,
  updateMemberAction,
} from './actions';
import { type DayRules, HoursEditor } from './hours-editor';

export const dynamic = 'force-dynamic';

const pair = (range: { readonly start: number; readonly end: number }) => ({
  start: formatTimeOfDay(range.start),
  end: formatTimeOfDay(range.end),
});

export default async function TeamMemberPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string; readonly memberId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug, memberId }, query] = await Promise.all([params, searchParams]);
  const { ctx, tenant } = await loadWorkspace(slug);
  const canTeam = ctx.role !== null && can(ctx.role, 'team.manage');
  const canSchedule = ctx.role !== null && can(ctx.role, 'schedules.manage');
  let data;
  try {
    data = await getTenancy().withTenant(ctx, async (tx) => ({
      member: await getTeamMember(tx, memberId),
      services: await listServices(tx),
      eligible: new Set(await staffServiceIds(tx, memberId)),
      hours: await getWorkingHours(tx, memberId),
      locations: await listLocations(tx),
      exceptions: (await listCurrentExceptions(tx, getClock())).filter(
        (exception) => exception.teamMemberId === memberId,
      ),
      areas: await getServiceAreas(tx, memberId),
      capacity: await getDailyCapacity(tx, memberId),
      memberships: await listMembers(tx),
      teamMembers: await listTeamMembers(tx),
    }));
  } catch (error) {
    // Another tenant's team member, a malformed id and a missing one look the same: 404.
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
  const { member, services, eligible, hours, locations, exceptions, areas, capacity } = data;
  // The location shown is a navigation choice (an id, never a message), checked against the list.
  const requested = Array.isArray(query.location) ? query.location[0] : query.location;
  const location = locations.find((l) => l.id === requested) ?? locations[0];
  const atLocation = hours.filter((h) => h.locationId === location?.id);
  const week = WEEKDAYS.map((weekday) => {
    const ranges = atLocation.filter((h) => h.weekday === weekday);
    const rules: DayRules = {
      ranges: ranges.map(pair),
      breaks: ranges.flatMap((range) => range.breaks.map(pair)),
    };
    return { weekday, name: WEEKDAY_NAMES[weekday], rules };
  });
  const zoneOf = new Map(locations.map((l) => [l.id, l.timeZone]));
  const nameOf = new Map(locations.map((l) => [l.id, l.name]));
  const showAreas =
    isHealthBusiness(tenant.businessType) || services.some((s) => s.locationType === 'client_home');
  const showCapacity =
    tenant.businessType === 'event_planner' || services.some((s) => s.bookingMode === 'request');
  const linkedElsewhere = new Set(
    data.teamMembers.filter((t) => t.id !== member.id).map((t) => t.membershipId),
  );
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memberId" value={member.id} />
    </>
  );

  return (
    <>
      <p>
        <Link href={`/app/${slug}/team`}>← Team</Link>
      </p>
      <h1>{member.displayName}</h1>
      {!member.active && <p className="warning">Inactive: offered for no service.</p>}

      <section className="card" aria-labelledby="details-heading">
        <h2 id="details-heading">Details</h2>
        <ActionForm action={updateMemberAction} label="Details">
          {hidden}
          <fieldset disabled={!canTeam}>
            <legend className="muted">Who</legend>
            <div className="day">
              <TextInput
                name="displayName"
                label="Display name"
                required
                maxLength={80}
                defaultValue={member.displayName}
              />
              <SelectInput
                name="membershipId"
                label="Signs in as"
                defaultValue={member.membershipId ?? ''}
                options={[
                  { value: '', label: 'Nobody: does not sign in' },
                  ...data.memberships
                    .filter((m) => !linkedElsewhere.has(m.id))
                    .map((m) => ({
                      value: m.id,
                      label: `${m.userId === ctx.actorId ? 'You' : `Member ${m.userId.slice(0, 8)}`} (${m.role})`,
                    })),
                ]}
              />
            </div>
          </fieldset>
          {canTeam && (
            <div>
              <SubmitButton>Save details</SubmitButton>
            </div>
          )}
        </ActionForm>
        {canTeam && (
          <ActionForm action={setActiveAction} label="Active">
            {hidden}
            <input type="hidden" name="active" value={member.active ? 'false' : 'true'} />
            <div>
              <SubmitButton className="quiet">
                {member.active ? 'Deactivate' : 'Reactivate'}
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </section>

      <section className="card" aria-labelledby="services-heading">
        <h2 id="services-heading">Services they deliver</h2>
        {services.length === 0 ? (
          <p className="muted">
            No services yet. <Link href={`/app/${slug}/services`}>Add one</Link>.
          </p>
        ) : (
          <ActionForm action={setServicesAction} label="Eligible services">
            {hidden}
            <fieldset disabled={!canTeam}>
              <legend className="muted">Eligible services</legend>
              {services.map((service) => (
                <CheckInput
                  key={service.id}
                  name="serviceIds"
                  value={service.id}
                  label={service.name}
                  defaultChecked={eligible.has(service.id)}
                />
              ))}
            </fieldset>
            {canTeam && (
              <div>
                <SubmitButton>Save services</SubmitButton>
              </div>
            )}
          </ActionForm>
        )}
      </section>

      <section className="card" aria-labelledby="hours-heading">
        <h2 id="hours-heading">Weekly hours</h2>
        {location === undefined ? (
          <p className="muted">No location.</p>
        ) : (
          <>
            <p className="muted">
              Local time at {location.name} ({location.timeZone}). The hours stay the same through
              clock changes.
            </p>
            {locations.length > 1 && (
              <nav aria-label="Location" className="actions">
                {locations.map((l) => (
                  <Link
                    key={l.id}
                    href={`/app/${slug}/team/${member.id}?location=${l.id}`}
                    aria-current={l.id === location.id ? 'true' : undefined}
                  >
                    {l.name}
                  </Link>
                ))}
              </nav>
            )}
            <ActionForm action={setHoursAction} label="Weekly hours">
              {hidden}
              <input type="hidden" name="locationId" value={location.id} />
              {/* Keyed by the stored rules: a successful save remounts it with what was stored. */}
              <HoursEditor
                key={JSON.stringify(week)}
                days={week}
                maxRanges={MAX_RANGES_PER_DAY}
                maxBreaks={MAX_BREAKS_PER_DAY}
                disabled={!canSchedule}
              />
              {canSchedule && (
                <div>
                  <SubmitButton>Save hours</SubmitButton>
                </div>
              )}
            </ActionForm>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="time-off-heading">
        <h2 id="time-off-heading">Time off</h2>
        {exceptions.length === 0 ? (
          <p className="muted">None booked.</p>
        ) : (
          <ul className="plain" aria-label="Upcoming time off">
            {exceptions.map((exception) => {
              const format = new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: zoneOf.get(exception.locationId) ?? tenant.timeZone,
              });
              return (
                <li key={exception.id}>
                  {format.format(exception.startsAt)} – {format.format(exception.endsAt)}{' '}
                  <span className="muted">({nameOf.get(exception.locationId)})</span>
                  {canSchedule && (
                    <ActionForm action={deleteTimeOffAction} label="Remove time off">
                      {hidden}
                      <input type="hidden" name="exceptionId" value={exception.id} />
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
        {canSchedule && location !== undefined && (
          <ActionForm action={addTimeOffAction} label="Add time off">
            {hidden}
            {locations.length > 1 ? (
              <SelectInput
                name="locationId"
                label="Location (its time zone applies)"
                defaultValue={location.id}
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            ) : (
              <input type="hidden" name="locationId" value={location.id} />
            )}
            <div className="row">
              <TextInput type="datetime-local" name="startsAt" label="From" required />
              <TextInput type="datetime-local" name="endsAt" label="Until" required />
            </div>
            <div>
              <SubmitButton>Add time off</SubmitButton>
            </div>
          </ActionForm>
        )}
      </section>

      {showAreas && (
        <section className="card" aria-labelledby="areas-heading">
          <h2 id="areas-heading">Home visits</h2>
          <ActionForm action={setAreasAction} label="Home visits">
            {hidden}
            <fieldset disabled={!canTeam}>
              <legend className="muted">Postcode districts and travel time</legend>
              <div className="day">
                <TextAreaInput
                  name="districts"
                  label="Postcode districts (e.g. SW1A, N1; no full postcodes)"
                  rows={2}
                  defaultValue={areas.districts.join(', ')}
                />
                <div className="row">
                  <TextInput
                    type="number"
                    name="travelBeforeMinutes"
                    label="Travel before (minutes)"
                    min={0}
                    max={240}
                    defaultValue={areas.travelBeforeMinutes}
                  />
                  <TextInput
                    type="number"
                    name="travelAfterMinutes"
                    label="Travel after (minutes)"
                    min={0}
                    max={240}
                    defaultValue={areas.travelAfterMinutes}
                  />
                </div>
              </div>
            </fieldset>
            {canTeam && (
              <div>
                <SubmitButton>Save home visits</SubmitButton>
              </div>
            )}
          </ActionForm>
        </section>
      )}

      {showCapacity && (
        <section className="card" aria-labelledby="capacity-heading">
          <h2 id="capacity-heading">Daily capacity</h2>
          <p className="muted">
            Events per date across request services. Saved now; enforced when enquiries arrive.
          </p>
          <ActionForm action={setCapacityAction} label="Daily capacity">
            {hidden}
            <TextInput
              type="number"
              name="maxEventsPerDate"
              label="Events per date"
              min={1}
              max={MAX_EVENTS_PER_DATE}
              defaultValue={capacity?.maxEventsPerDate ?? ''}
              disabled={!canSchedule}
            />
            {canSchedule && (
              <div>
                <SubmitButton>Save capacity</SubmitButton>
              </div>
            )}
          </ActionForm>
          {canSchedule && capacity !== null && (
            <ActionForm action={removeCapacityAction} label="Remove capacity limit">
              {hidden}
              <div>
                <SubmitButton className="quiet">Remove limit</SubmitButton>
              </div>
            </ActionForm>
          )}
        </section>
      )}
    </>
  );
}
