-- Phase 2: slug resolution, tenants visible to their members, business settings updates, and
-- row level security for tenant_invitations (docs/phases.md Phase 2, docs/adr/ADR-004).

-- Resolves a URL slug to a tenant id before any tenant context exists (a signed-in user picking a
-- workspace; public booking pages from Phase 5). SECURITY DEFINER so it runs as the owner and can
-- read tenants under forced RLS, with an empty search_path so every name is schema-qualified. It
-- returns only the id, or null, and only rebook_app may call it.
create or replace function rebook.resolve_tenant_slug(slug text)
returns uuid
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select t.id from rebook.tenants t where t.slug = resolve_tenant_slug.slug;
$$;
comment on function rebook.resolve_tenant_slug(text) is 'Tenant id for a URL slug, or null. SECURITY DEFINER with empty search_path; executable by rebook_app only.';

revoke all on function rebook.resolve_tenant_slug(text) from public;
revoke all on function rebook.resolve_tenant_slug(text) from anon, authenticated, service_role;
grant execute on function rebook.resolve_tenant_slug(text) to rebook_app;

-- tenants: a user actor with NO tenant chosen (withUserContext) sees the tenants where they
-- hold an active membership, so the back-office switcher can be listed. Inside a tenant
-- context the branch is off: a user then sees only the current tenant's row. The subquery runs
-- under the memberships select policy, whose actor branch is user-only.
create policy tenants_select_member on rebook.tenants
  for select to rebook_app
  using (
    (select current_setting('app.actor_kind', true)) = 'user'
    and (select nullif(current_setting('app.tenant_id', true), '')) is null
    and exists (
      select 1 from rebook.tenant_memberships m
      where m.tenant_id = tenants.id
        and m.user_id = (select nullif(current_setting('app.actor_id', true), '')::uuid)
        and m.revoked_at is null
    )
  );

-- tenants: owners update business settings (the permission check is in the application layer;
-- RLS only keeps it to the current tenant). The slug is immutable: invite links, bookmarks and,
-- from Phase 5, public booking pages depend on it.
create policy tenants_update_current on rebook.tenants
  for update to rebook_app
  using (id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

grant update on rebook.tenants to rebook_app;

create or replace function rebook.tenants_slug_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'tenants.slug is immutable' using errcode = 'check_violation', constraint = 'tenants_slug_immutable';
  end if;
  return new;
end
$$;
comment on function rebook.tenants_slug_immutable() is 'Trigger: rejects any change to tenants.slug.';
revoke all on function rebook.tenants_slug_immutable() from public;

create trigger tenants_slug_immutable
  before update of slug on rebook.tenants
  for each row execute function rebook.tenants_slug_immutable();

-- Health businesses stay health businesses. A midwife tenant carries patient data under the
-- health rules (neutral messaging, no marketing sends, no clinical fields); switching it to a
-- non-health type would lift those rules over existing clients. Non-health → midwife and changes
-- between non-health types are allowed. The application checks the same rule first and gives a
-- typed error; this trigger is the backstop.
create or replace function rebook.tenants_business_type_health_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.business_type = 'midwife' and new.business_type <> 'midwife' then
    raise exception 'a health business cannot become a non-health business'
      using errcode = 'check_violation', constraint = 'tenants_business_type_health_lock';
  end if;
  return new;
end
$$;
comment on function rebook.tenants_business_type_health_lock() is 'Trigger: rejects changing business_type from midwife to a non-health type.';
revoke all on function rebook.tenants_business_type_health_lock() from public;

create trigger tenants_business_type_health_lock
  before update of business_type on rebook.tenants
  for each row execute function rebook.tenants_business_type_health_lock();

-- tenant_invitations: tenant-scoped like every other table. The app creates, lists, accepts and
-- revokes invitations (revoking is an update); nothing deletes them. The worker will read them
-- when invitation emails arrive in Phase 6.
alter table rebook.tenant_invitations force row level security;

create policy tenant_invitations_tenant_isolation on rebook.tenant_invitations
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

grant select, insert, update on rebook.tenant_invitations to rebook_app;
grant select on rebook.tenant_invitations to rebook_worker;

-- One open invitation per address per tenant. The application refuses a duplicate before it
-- inserts; this index settles the race between two owners inviting the same person at once.
create unique index tenant_invitations_open_email_unique
  on rebook.tenant_invitations (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table rebook.tenant_invitations
  add constraint tenant_invitations_invited_by_auth_users_fk
  foreign key (invited_by) references auth.users (id) on delete set null;
alter table rebook.tenant_invitations
  add constraint tenant_invitations_accepted_by_auth_users_fk
  foreign key (accepted_by) references auth.users (id) on delete set null;

-- Fixed-window rate limiting (docs/architecture.md §10 and §12: a Postgres table at MVP load,
-- swappable behind an interface later). Platform-level, so no tenant_id: sign-in and sign-up
-- happen before any tenant exists; `pnpm db:check-schema` allow-lists the table for that reason.
-- Keys are SHA-256 hashes computed by the app from scope, kind and value, so the table never
-- holds an IP address or an email address. Reached through withAnonymousContext as rebook_app.
create table rebook.rate_limits (
  key text not null,
  window_start timestamptz not null,
  -- Each row knows its own window length, so the sweep below can judge staleness per row
  -- instead of by the caller's window (a short-window scope must never erase a long one).
  window_seconds integer not null,
  count integer not null default 0,
  constraint rate_limits_pkey primary key (key, window_start),
  constraint rate_limits_key_format check (key ~ '^[0-9a-f]{64}$'),
  constraint rate_limits_window_positive check (window_seconds > 0),
  constraint rate_limits_count_not_negative check (count >= 0)
);
comment on table rebook.rate_limits is 'Fixed-window counters for rate limiting, keyed by hashed scope:kind:value. No tenant_id by design.';

alter table rebook.rate_limits enable row level security;
alter table rebook.rate_limits force row level security;

create policy rate_limits_app_access on rebook.rate_limits
  for all to rebook_app
  using (true)
  with check (true);

grant select, insert, update, delete on rebook.rate_limits to rebook_app;

-- Counts one hit for `p_key` in the fixed window containing `p_at` and reports whether the
-- caller is still within `p_max_hits`. The clock is a parameter so the application passes its
-- own and tests can move windows. A 1 % chance of sweeping windows that ended more than their
-- own length ago keeps the table small without a job; a live counter is never swept, whatever
-- window the sweeping caller uses.
create or replace function rebook.rate_limit_hit(
  p_key text,
  p_window_seconds integer,
  p_max_hits integer,
  p_at timestamptz
)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- Named unlike the column so plpgsql cannot confuse the two in the insert below.
  win_start timestamptz := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.extract('epoch', p_at) / p_window_seconds) * p_window_seconds
  );
  hits integer;
begin
  insert into rebook.rate_limits as r (key, window_start, window_seconds, count)
    values (p_key, win_start, p_window_seconds, 1)
    on conflict (key, window_start) do update set count = r.count + 1
    returning r.count into hits;
  if pg_catalog.random() < 0.01 then
    delete from rebook.rate_limits r
      where r.window_start + pg_catalog.make_interval(secs => r.window_seconds * 2) < p_at;
  end if;
  return hits <= p_max_hits;
end
$$;
comment on function rebook.rate_limit_hit(text, integer, integer, timestamptz) is 'Counts one hit in the fixed window containing p_at; true while within p_max_hits. Executable by rebook_app only.';

revoke all on function rebook.rate_limit_hit(text, integer, integer, timestamptz) from public;
grant execute on function rebook.rate_limit_hit(text, integer, integer, timestamptz) to rebook_app;
