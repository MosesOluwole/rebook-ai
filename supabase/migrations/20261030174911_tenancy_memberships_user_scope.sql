-- Phase 2, Phase 1 follow-ups (docs/phases.md Phase 2; docs/adr/ADR-002 "revisit when").
--
-- 1. The memberships select policy's actor branch applies to user actors only. Before this, any
--    actor kind whose id happened to equal a user id (a customer token id, say) would have seen
--    that user's memberships across tenants.
-- 2. Memberships reference Supabase Auth users. Deleting an auth user removes their memberships.
--    auth.users is created by the Supabase Postgres image itself (not by GoTrue), so the
--    constraint can be created on a database-only CI stack as well as locally.

drop policy tenant_memberships_select on rebook.tenant_memberships;

create policy tenant_memberships_select on rebook.tenant_memberships
  for select to rebook_app, rebook_worker
  using (
    tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)
    or (
      (select current_setting('app.actor_kind', true)) = 'user'
      and user_id = (select nullif(current_setting('app.actor_id', true), '')::uuid)
    )
  );

alter table rebook.tenant_memberships
  add constraint tenant_memberships_user_id_auth_users_fk
  foreign key (user_id) references auth.users (id) on delete cascade;
