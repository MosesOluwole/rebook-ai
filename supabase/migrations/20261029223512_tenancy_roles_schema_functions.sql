-- Phase 1 foundation, part 1 of 3: roles, the rebook schema and helper functions.
-- Runs as Supabase's `postgres` role, the design's rebook_owner (docs/architecture.md §4,
-- docs/adr/ADR-002-schema-roles-context.md). Roles are cluster-wide and survive
-- `supabase db reset`, so every role statement tolerates a re-run.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'rebook_authenticator') then
    -- The only login role. NOINHERIT: it gains table privileges only after SET LOCAL ROLE.
    -- Its password is set outside migrations (`pnpm db:roles` locally, platform secrets in production).
    create role rebook_authenticator login noinherit nobypassrls nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'rebook_app') then
    create role rebook_app nologin nobypassrls nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'rebook_worker') then
    create role rebook_worker nologin nobypassrls nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'rebook_platform') then
    create role rebook_platform nologin nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end
$$;

comment on role rebook_authenticator is 'Rebook AI login role for the app, worker and tests. No table privileges; withTenant switches to rebook_app or rebook_worker per transaction.';
comment on role rebook_app is 'Rebook AI web request role. NOBYPASSRLS; entered with SET LOCAL ROLE inside withTenant.';
comment on role rebook_worker is 'Rebook AI background job role. NOBYPASSRLS; entered with SET LOCAL ROLE inside withWorkerTenant.';
comment on role rebook_platform is 'Rebook AI platform support role. Reserved; no grants until support access grants exist.';

grant rebook_app to rebook_authenticator;
grant rebook_worker to rebook_authenticator;

-- Application schema. Not listed in [api].schemas of supabase/config.toml, and anon /
-- authenticated never receive privileges on it (enforced by `pnpm db:check-schema`).
create schema if not exists rebook;
comment on schema rebook is 'Rebook AI application tables. Reached only through withTenant as rebook_app or rebook_worker.';
revoke all on schema rebook from public;
grant usage on schema rebook to rebook_app, rebook_worker;

-- UUID version 7 (RFC 9562). Postgres 17 has no built-in uuidv7(); this is the default for every
-- primary key. The millisecond fraction fills the 12 rand_a bits (RFC 9562 §6.2, method 3), so
-- ids generated within the same millisecond still sort in creation order.
create or replace function rebook.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
set search_path = ''
as $$
declare
  unix_micros bigint := (pg_catalog.extract('epoch', pg_catalog.clock_timestamp()) * 1000000)::bigint;
  unix_millis bigint := unix_micros / 1000;
  sub_millis int := ((unix_micros % 1000) * 4096) / 1000;
  -- Bytes 9..16 of a random UUID already carry the RFC variant bits (10xx) in their first byte.
  random_tail bytea := pg_catalog.substring(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 9, 8);
begin
  return pg_catalog.encode(
    pg_catalog.substring(pg_catalog.int8send(unix_millis), 3, 6)
      -- 0x7000 | sub_millis: version nibble 7, then the 12-bit millisecond fraction.
      || pg_catalog.int2send((28672 + sub_millis)::int2)
      || random_tail,
    'hex')::uuid;
end
$$;
comment on function rebook.uuid_generate_v7() is 'UUIDv7 with sub-millisecond ordering (RFC 9562 §6.2 method 3). Default for every primary key.';

-- IANA time zone names are the only accepted zone values (docs/architecture.md §5): the
-- Area/Location form such as Europe/London, or UTC. pg_timezone_names also lists abbreviations
-- (EST) and legacy single words (GB, Zulu); those are rejected. Declared immutable so it can back
-- CHECK constraints; the tz database only grows.
create or replace function rebook.is_time_zone(zone text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select zone is not null
     and (zone = 'UTC' or zone like '%/%')
     and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = zone);
$$;
comment on function rebook.is_time_zone(text) is 'True when the argument is an IANA time zone name known to Postgres (Area/Location form, or UTC).';

revoke all on function rebook.uuid_generate_v7() from public;
revoke all on function rebook.is_time_zone(text) from public;
grant execute on function rebook.uuid_generate_v7() to rebook_app, rebook_worker;
grant execute on function rebook.is_time_zone(text) to rebook_app, rebook_worker;
