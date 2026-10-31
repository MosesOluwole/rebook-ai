-- Phase 3: row level security, privileges, constraints and triggers for the booking configuration
-- and custom field tables (docs/phases.md Phase 3, docs/architecture.md §5 and §6, ADR-005).
-- The tables and their indexes are in 20261031162932_booking_crm_tables.sql (Drizzle Kit).

-- btree_gist lets an exclusion constraint compare uuid and smallint columns with = next to a
-- range with &&. Phase 4's no_overlap constraint on bookings needs it too.
create extension if not exists btree_gist with schema extensions;

-- A range of wall-clock times within one day, for the working-hours exclusion constraints.
-- time admits 24:00, so a range may end at midnight.
create type rebook.time_range as range (subtype = time);
comment on type rebook.time_range is 'Wall-clock time range within a day, [start, end).';

-- ---- Which business types are health businesses -----------------------------------------------
-- The one SQL statement of the rule, mirrored by isHealthBusiness in
-- src/modules/tenancy/domain/business-type.ts; tests/integration/tenancy/health-business-type.test.ts
-- fails if the two lists ever disagree. Every health trigger calls this function, so a second
-- health type changes one function here and one line there. Immutable because the answer
-- depends only on the argument; never use it in an index, generated column or CHECK, so changing
-- the list never requires a rebuild.
create or replace function rebook.is_health_business_type(business_type text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(is_health_business_type.business_type in ('midwife'), false);
$$;
comment on function rebook.is_health_business_type(text) is 'True for health business types (neutral messaging, no clinical or client custom fields). Mirrors isHealthBusiness in the domain.';
revoke all on function rebook.is_health_business_type(text) from public;
grant execute on function rebook.is_health_business_type(text) to rebook_app, rebook_worker;

-- The Phase 2 health lock (migration 20261030174913, on master and never edited) named 'midwife'
-- itself; its body is replaced here to use the shared rule. Same name, same trigger, same message
-- and constraint, so the application's error mapping is unchanged.
create or replace function rebook.tenants_business_type_health_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if rebook.is_health_business_type(old.business_type)
     and not rebook.is_health_business_type(new.business_type) then
    raise exception 'a health business cannot become a non-health business'
      using errcode = 'check_violation', constraint = 'tenants_business_type_health_lock';
  end if;
  return new;
end
$$;
comment on function rebook.tenants_business_type_health_lock() is 'Trigger: rejects changing a health business type to a non-health type (rebook.is_health_business_type).';

-- ---- Composite key that Drizzle cannot express ----------------------------------------------
-- A team member may be linked to a membership. When the membership disappears (its auth user is
-- deleted, which cascades to memberships), only membership_id is nulled; tenant_id must stay.
alter table rebook.team_members
  add constraint team_members_membership_fk
  foreign key (tenant_id, membership_id) references rebook.tenant_memberships (tenant_id, id)
  on delete set null (membership_id);

-- ---- Exclusion constraints -------------------------------------------------------------------
-- One team member cannot work two overlapping ranges on the same weekday, whatever the location
-- (they cannot be in two places). Touching ranges (09:00–12:00 and 12:00–17:00) are allowed.
alter table rebook.working_hours
  add constraint working_hours_no_overlap exclude using gist (
    tenant_id with =,
    team_member_id with =,
    weekday with =,
    rebook.time_range(start_time, end_time) with &&
  );

alter table rebook.working_hour_breaks
  add constraint working_hour_breaks_no_overlap exclude using gist (
    tenant_id with =,
    working_hours_id with =,
    rebook.time_range(start_time, end_time) with &&
  );

-- ---- Row level security ----------------------------------------------------------------------
alter table rebook.services force row level security;
alter table rebook.team_members force row level security;
alter table rebook.staff_services force row level security;
alter table rebook.working_hours force row level security;
alter table rebook.working_hour_breaks force row level security;
alter table rebook.availability_exceptions force row level security;
alter table rebook.team_member_service_areas force row level security;
alter table rebook.daily_capacity_rules force row level security;
alter table rebook.custom_field_definitions force row level security;
alter table rebook.custom_field_values force row level security;

-- services: tenant-scoped, and an unpublished service is invisible to public actors
-- (anonymous visitors and customers holding a token, Phase 5). Members, jobs and the system see
-- every service of the tenant. Unpublishing is a flag change, never a delete, so nothing that
-- references the service is touched.
create policy services_select on rebook.services
  for select to rebook_app, rebook_worker
  using (
    tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)
    and (
      published
      or (select current_setting('app.actor_kind', true)) in ('user', 'worker', 'system')
    )
  );

create policy services_insert on rebook.services
  for insert to rebook_app
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy services_update on rebook.services
  for update to rebook_app
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy services_delete on rebook.services
  for delete to rebook_app
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Every other table: one tenant policy for all commands, as in Phase 1.
create policy team_members_tenant_isolation on rebook.team_members
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy staff_services_tenant_isolation on rebook.staff_services
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy working_hours_tenant_isolation on rebook.working_hours
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy working_hour_breaks_tenant_isolation on rebook.working_hour_breaks
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy availability_exceptions_tenant_isolation on rebook.availability_exceptions
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy team_member_service_areas_tenant_isolation on rebook.team_member_service_areas
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy daily_capacity_rules_tenant_isolation on rebook.daily_capacity_rules
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy custom_field_definitions_tenant_isolation on rebook.custom_field_definitions
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy custom_field_values_tenant_isolation on rebook.custom_field_values
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

-- ---- Privileges ------------------------------------------------------------------------------
-- The back office configures; jobs only read configuration (reminders, capacity from Phase 6
-- and 7), so the worker holds SELECT and nothing else on these tables.
grant select, insert, update, delete on
  rebook.services,
  rebook.team_members,
  rebook.staff_services,
  rebook.working_hours,
  rebook.working_hour_breaks,
  rebook.availability_exceptions,
  rebook.team_member_service_areas,
  rebook.daily_capacity_rules,
  rebook.custom_field_definitions,
  rebook.custom_field_values
to rebook_app;

grant select on
  rebook.services,
  rebook.team_members,
  rebook.staff_services,
  rebook.working_hours,
  rebook.working_hour_breaks,
  rebook.availability_exceptions,
  rebook.team_member_service_areas,
  rebook.daily_capacity_rules,
  rebook.custom_field_definitions,
  rebook.custom_field_values
to rebook_worker;

-- ---- Business type lock ------------------------------------------------------------------------
-- Creating a service share-locks its tenant row, in the database, so a business type change
-- (which updates that row) and a first service serialise even for a writer that skips the
-- application's lock; the service-lock trigger below then sees the committed service.
create or replace function rebook.services_lock_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from rebook.tenants t where t.id = new.tenant_id for share;
  return new;
end
$$;
comment on function rebook.services_lock_tenant() is 'Trigger: share-locks the tenant row while a service is inserted, serialising it with business type changes.';
revoke all on function rebook.services_lock_tenant() from public;

create trigger services_lock_tenant
  before insert on rebook.services
  for each row execute function rebook.services_lock_tenant();

-- A business type cannot change once the tenant has any service (docs/phases.md Phase 3): its
-- services' defaults and booking modes were chosen for the type they were created under. The
-- application checks first, with the tenant row locked, and gives a typed error; this trigger is
-- the backstop. It runs as the caller, so under RLS it sees exactly the current tenant's services.
-- It fires after tenants_business_type_health_lock (triggers fire in name order), so a midwife
-- tenant asking to become non-health still gets the health message.
create or replace function rebook.tenants_business_type_service_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.business_type is distinct from old.business_type
     and exists (select 1 from rebook.services s where s.tenant_id = new.id) then
    raise exception 'the business type cannot change once the tenant has services'
      using errcode = 'check_violation', constraint = 'tenants_business_type_service_lock';
  end if;
  return new;
end
$$;
comment on function rebook.tenants_business_type_service_lock() is 'Trigger: rejects a business_type change while the tenant has any service.';
revoke all on function rebook.tenants_business_type_service_lock() from public;

create trigger tenants_business_type_service_lock
  before update of business_type on rebook.tenants
  for each row execute function rebook.tenants_business_type_service_lock();

-- ---- Health businesses and custom fields --------------------------------------------------------
-- Data minimisation for health businesses (docs/phases.md Phase 3, ADR-005 §6): no client-scoped
-- custom fields at all in the MVP, and no free-text service field unless an owner set the audited
-- override on it. The application refuses both first with typed errors; this trigger is the
-- backstop for inserts and updates alike.
create or replace function rebook.custom_field_definitions_health_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_business_type text;
begin
  -- FOR SHARE on the tenant row: a business type change (which updates that row) waits for this
  -- transaction, or this waits for it and reads the new type. The lock is taken here, in the
  -- database, so no writer can race the rule by skipping the application's own lock.
  select t.business_type into v_business_type
    from rebook.tenants t where t.id = new.tenant_id for share;
  if rebook.is_health_business_type(v_business_type) then
    if new.entity = 'client' then
      raise exception 'a health business cannot define client custom fields'
        using errcode = 'check_violation', constraint = 'custom_field_definitions_health_client';
    end if;
    if new.field_type in ('text', 'long_text') and not new.health_free_text_override then
      raise exception 'a health business needs the override for a free-text custom field'
        using errcode = 'check_violation', constraint = 'custom_field_definitions_health_free_text';
    end if;
  end if;
  return new;
end
$$;
comment on function rebook.custom_field_definitions_health_rules() is 'Trigger: in a health business, rejects client-scoped custom fields and free-text fields without the override.';
revoke all on function rebook.custom_field_definitions_health_rules() from public;

create trigger custom_field_definitions_health_rules
  before insert or update on rebook.custom_field_definitions
  for each row execute function rebook.custom_field_definitions_health_rules();

-- ---- Becoming a health business: no fields the health rules forbid -----------------------------
-- A non-health business may define client fields and free-text fields freely. Becoming a midwife
-- business is refused while any client-scoped definition, or any free-text definition without
-- the override, exists; the owner deletes them first. The application refuses first
-- (HealthCustomFieldsError) with the tenant row locked FOR UPDATE, while creating a definition
-- takes FOR SHARE, so the two cannot interleave; this trigger is the backstop.
create or replace function rebook.tenants_business_type_custom_fields_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if rebook.is_health_business_type(new.business_type)
     and not rebook.is_health_business_type(old.business_type)
     and exists (
       select 1 from rebook.custom_field_definitions d
       where d.tenant_id = new.id
         and (
           d.entity = 'client'
           or (d.field_type in ('text', 'long_text') and not d.health_free_text_override)
         )
     ) then
    raise exception 'a business with client or free-text custom fields cannot become a health business'
      using errcode = 'check_violation', constraint = 'tenants_business_type_custom_fields_lock';
  end if;
  return new;
end
$$;
comment on function rebook.tenants_business_type_custom_fields_lock() is 'Trigger: rejects becoming a health business while client custom fields or un-overridden free-text fields exist.';
revoke all on function rebook.tenants_business_type_custom_fields_lock() from public;

create trigger tenants_business_type_custom_fields_lock
  before update of business_type on rebook.tenants
  for each row execute function rebook.tenants_business_type_custom_fields_lock();

-- ---- Revoking a membership keeps the team member ----------------------------------------------
-- A revoked member can no longer sign in, but the person stays on the team with their hours,
-- time off and (from Phase 4) bookings: the team member is unlinked, never deleted. Deleting the
-- auth user is covered by team_members_membership_fk (ON DELETE SET NULL (membership_id)).
-- Runs as the caller, so RLS keeps it inside the current tenant.
create or replace function rebook.tenant_memberships_unlink_team_member()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update rebook.team_members
      set membership_id = null, updated_at = now()
      where tenant_id = new.tenant_id and membership_id = new.id;
  end if;
  return new;
end
$$;
comment on function rebook.tenant_memberships_unlink_team_member() is 'Trigger: unlinks the team member of a membership when the membership is revoked.';
revoke all on function rebook.tenant_memberships_unlink_team_member() from public;

create trigger tenant_memberships_unlink_team_member
  after update of revoked_at on rebook.tenant_memberships
  for each row execute function rebook.tenant_memberships_unlink_team_member();
