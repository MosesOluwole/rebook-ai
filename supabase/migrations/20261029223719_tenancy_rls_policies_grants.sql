-- Phase 1 foundation, part 3 of 3: forced row level security, policies and table privileges.
--
-- Policies read the transaction-local settings installed by withTenant (SET LOCAL ROLE plus
-- set_config(..., true)). The nullif matters: once a pooled connection has had app.tenant_id
-- set, a later transaction without context reads it back as '' and a bare ::uuid cast would
-- raise an error instead of matching nothing. With nullif the comparison is against NULL, so
-- every policy fails closed to zero rows.

alter table rebook.tenants force row level security;
alter table rebook.tenant_memberships force row level security;
alter table rebook.locations force row level security;
alter table rebook.audit_logs force row level security;
alter table rebook.tenant_feature_flags force row level security;
alter table rebook.idempotency_keys force row level security;

-- tenants: the row is the tenant. Readable and insertable only for the current tenant id; the
-- app generates the id, opens the context with it, then inserts. No update or delete policy yet.
create policy tenants_select_current on rebook.tenants
  for select to rebook_app, rebook_worker
  using (id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy tenants_insert_current on rebook.tenants
  for insert to rebook_app, rebook_worker
  with check (id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

-- tenant_memberships: a tenant manages its memberships, and a user also sees their own
-- memberships across tenants so Phase 2 can list a signed-in user's tenants.
create policy tenant_memberships_select on rebook.tenant_memberships
  for select to rebook_app, rebook_worker
  using (
    tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)
    or user_id = (select nullif(current_setting('app.actor_id', true), '')::uuid)
  );

create policy tenant_memberships_insert on rebook.tenant_memberships
  for insert to rebook_app, rebook_worker
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy tenant_memberships_update on rebook.tenant_memberships
  for update to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy tenant_memberships_delete on rebook.tenant_memberships
  for delete to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Every other tenant-owned table: one policy covering all commands.
create policy locations_tenant_isolation on rebook.locations
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy audit_logs_tenant_isolation on rebook.audit_logs
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy tenant_feature_flags_tenant_isolation on rebook.tenant_feature_flags
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

create policy idempotency_keys_tenant_isolation on rebook.idempotency_keys
  for all to rebook_app, rebook_worker
  using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Table privileges for the runtime roles. rebook_app and rebook_worker are identical in Phase 1;
-- the worker's set is narrowed when jobs arrive (Phase 6). rebook_authenticator, rebook_platform,
-- anon and authenticated receive nothing.
grant select, insert on rebook.tenants to rebook_app, rebook_worker;
grant select, insert, update, delete on rebook.tenant_memberships to rebook_app, rebook_worker;
grant select, insert, update, delete on rebook.locations to rebook_app, rebook_worker;
-- audit_logs is append-only: no update, delete or truncate for runtime roles.
grant select, insert on rebook.audit_logs to rebook_app, rebook_worker;
grant select, insert, update, delete on rebook.tenant_feature_flags to rebook_app, rebook_worker;
grant select, insert, update, delete on rebook.idempotency_keys to rebook_app, rebook_worker;
