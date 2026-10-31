# ADR-005: Booking configuration: services, team, schedules and custom fields

- **Status:** Proposed (Phase 3). Becomes Accepted when Moses merges Phase 3.
- **Date:** 2026-10-31
- **Deciders:** Moses Oluwole (owner); drafted by Claude Code during Phase 3.
- **Source design:** `docs/architecture.md` §1, §3, §5 and §6; `docs/phases.md`, Phase 3;
  ADR-002 (schema, roles, context), ADR-003 (time zones), ADR-004 (identity and authorisation).

## Context

Availability (Phase 4) and enquiries (Phase 7) are computed from configuration, so Phase 3 must
store it completely and validate it before the booking engine exists. These are the first tables
whose parents are tenant-owned, so composite keys stop being a probe and become the norm. The
phase also had fixed points from Moses: the business type locks once services exist, working
hours are wall-clock rules per location with DST tests, money is `numeric(12,2)` plus an ISO
currency, custom fields are validated by a Zod schema per definition, health businesses get no
free-text field without an audited owner override, and daily capacity rules are configuration only.

## Decisions

### 1. Two modules, one dependency direction

`src/modules/booking` owns services, team members, eligibility (`staff_services`), working
hours and breaks, availability exceptions, service areas and daily capacity rules (design §3:
"Booking owns services, staff, availability and appointments"). `src/modules/crm` owns custom
fields (§3: "CRM owns … custom fields"). Dependencies run `crm → booking → tenancy`; no cycles.
`ValidationError` moved to `src/shared/kernel/validation-error.ts` (tenancy re-exports it) so every
module's domain layer throws the same typed error, now with `fieldErrors` keyed by input path.

### 2. Business type lock: a port, two row locks and a trigger

Tenancy cannot import booking or crm, so `updateBusinessSettings(tx, input, guard)` takes a
`BusinessTypeGuard` (`{ hasServices, hasFieldsBarredForHealth }`); the caller passes
`businessTypeGuard` from `@/modules/crm`, which composes booking's `tenantHasServices`. The
rule is one domain function, `businessTypeChangeRefusal(from, to, hasServices)`: the Phase 2 health
lock first, then "no change once any service exists" (`BusinessTypeLockedError`). Keeping the type
while changing name or zone is always allowed.

Race: the settings command takes `FOR UPDATE` on the tenant row before checking; `createService`
takes `FOR SHARE` before inserting (it reads the type for its defaults anyway). The locks conflict,
so a service is either created after the change with the new type's defaults, or the change waits
and is refused. The trigger `tenants_business_type_service_lock` is the backstop; it fires after the
health trigger by name, so a midwife always gets the health message. The triggers also take the tenant-row lock themselves (`services_lock_tenant` on service
inserts; `custom_field_definitions_health_rules` reads the type `FOR SHARE`), so a writer that
skips the application's lock, such as a future import or job, still serialises with a type change
(tests/integration/booking/trigger-locks.test.ts, mutation-checked). A 10-round concurrent test
proves the end states. Deleting every service lifts the lock (the message says so).

### 3. Composite keys everywhere, enforced by the CI check

Every child references its tenant-owned parent as `(tenant_id, parent_id) → parent (tenant_id, id)`.
`pnpm db:check-schema` now requires the key to map the child's `tenant_id` to the parent's
`tenant_id` (Phase 1 only checked that the first local column was `tenant_id`, which a swapped
`(tenant_id, x) → parent (id, tenant_id)` key passed). Keys into a rebook table without
`tenant_id` (other than `tenants`) fail too. `team_members.membership_id` uses
`ON DELETE SET NULL (membership_id)`, hand-written because Drizzle cannot express the column list:
nulling `tenant_id` with it would break the row. Custom field values reference their definition
through `(tenant_id, definition_id, entity)`, so a service value cannot use a client definition.

### 4. Working hours are wall-clock rules; instants only for a date

`working_hours` stores weekday, `time` start and end (end may be `24:00`) per team member and
location; breaks are children of the range that contains them. Nothing is converted at save time.
`resolveWorkingDay(rules, date, zone)` converts for one local date with the location's IANA zone.
Node 24 has no Temporal, so the offset comes from `Intl.DateTimeFormat` (same tzdata as ADR-003):
a wall time inside a spring gap does not exist (`wallTimeToInstant` returns null, as the design's
slot rule says), an ambiguous one takes the earlier instant, and a _range edge_ inside a gap moves
to the end of the gap so the day still has its hours. Tests pin Europe/London on the last Sundays
of March and October 2026 and 2027, in the domain and through the database.

Overlaps: the domain refuses overlapping ranges on one day with a field path per range; the
exclusion constraint `working_hours_no_overlap` (needs `btree_gist`, now installed in `extensions`,
and the range type `rebook.time_range`) also refuses overlaps with the same person's hours at
another location, reported as a form-level error.

Time off and closures are specific stretches of time, so they are entered as local date-times in
the location's zone and stored as `timestamptz`; a local time inside a spring gap is refused.

### 5. Money, validation and the published flag

Price is a decimal string from the form to `numeric(12,2)`; never a float. More than two decimals,
negatives and more than ten integer digits are refused; currency must be in
`Intl.supportedValuesOf('currency')` (current ISO 4217 codes: 162 on ICU 78.3; `XYZ`, `DEM`,
`XAU` refused). The list comes from the pinned Node's ICU: if an upgrade ever
dropped a code in use, services in it could not be edited until the list is pinned in code; the
Node bump is the moment to check. Every service, schedule and capacity rule is validated server-side by Zod with
field paths, and ids from URLs and forms are checked as UUIDs (`requireId`: malformed is
`NotFoundError`, never a database cast error); CHECK constraints repeat the ranges (duration 5–1440, buffers and travel 0–240).

Unpublishing is a flag change. The `services_select` policy shows an unpublished service only to
`user`, `worker` and `system` actors, so the Phase 5 public read path cannot show one even if a
query forgets the filter; eligibility, custom values and (from Phase 4) bookings are untouched.

### 6. Custom fields and the health override

Definitions are per entity (`client`, `service`) with a key, label, type (`text`, `long_text`,
`number`, `boolean`, `date`, `select`, `multi_select`), options and required flag. `valueSchemaFor`
builds the Zod schema for one definition at write time; the whole set is refused with a message
per field if any value fails. Values exist only for services until clients arrive in Phase 5,
which adds `customer_id` and widens `custom_field_values_subject` (for non-health businesses).

Health businesses (data minimisation, Moses's Phase 3 decision): **no client-scoped custom
fields at all** in the MVP (`HealthClientFieldError`; the Custom fields page does not offer the
option), and a free-text _service_ field only with the override. The override is a per-field
decision with its own owner-only permission (`custom_fields.health_override`, checked first when
requested) and its own audit entry (`custom_field.health_override_enabled`, actor, before and
after, business type) in the same transaction. The trigger `custom_field_definitions_health_rules`
refuses both in the database, on insert and update (so a service field cannot be re-scoped to
clients, nor its override switched off). A non-health business may hold client fields and free
text, so the reverse path is closed too: becoming a health business is refused while any
client-scoped field, or any free-text field without the override, exists
(`HealthCustomFieldsError`, trigger `tenants_business_type_custom_fields_lock`); the owner deletes
those fields first. Which types are health businesses is stated once in SQL, `rebook.is_health_business_type(text)`
(immutable, empty `search_path`), which all three health triggers call (the Phase 2
`tenants_business_type_health_lock` body is replaced to use it, in this phase's migration), and
mirrored by `isHealthBusiness`; tests/integration/tenancy/health-business-type.test.ts fails if
the two lists disagree or a trigger names a type itself. The page shows a standing warning, and one on every overridden field.

### 7. Permissions, team membership and screens

New owner-only permissions: `services.manage`, `team.manage`, `schedules.manage`,
`custom_fields.manage`, `custom_fields.health_override`; staff read with `workspace.view`.

Team members and memberships (Moses's Phase 3 decisions): onboarding creates the owner's team
member, linked to the owner membership, inside the onboarding transaction. Tenancy cannot import
booking, so `createTenancy(db, clock, hooks)` takes booking's `onboardingHooks`; the hook accepts
only the registration grant. Revoking a membership keeps the team member, its hours, time off
and (from Phase 4) bookings: the trigger `tenant_memberships_unlink_team_member` nulls the link
when `revoked_at` is set, as `ON DELETE SET NULL (membership_id)` does when the auth user goes.
The display name starts as the business name and the owner can change it.

Screens: Services (list, create, detail with publish, delete and custom values), Team (team
members section) and a team member page (eligibility, weekly hours per location, time off,
home-visit areas and travel, daily capacity), Custom fields, Time off (all exceptions plus
location closures). The weekly hours editor renders every stored range and break and adds or
removes rows up to the domain maximum (4 each per day), so saving one day never drops another.

**Forms carry their outcome as server-action state, never in a URL** (Moses's Phase 3 decision,
applied to every Phase 2 and Phase 3 form). `ActionForm` wraps a server action in
`useActionState`; the action returns a `FormState` with a message, one message per field path
and the submitted values, so inputs are re-filled (secrets omitted) and nothing typed reaches a
URL, a log or the browser history. Inputs are keyed by a submission counter because React resets
a form after its action. The four auth flows stay route handlers so a refused attempt is a real
429 (ADR-004 §9): `RouteForm` posts with `Accept: application/json` and the route answers JSON
(`routeAnswer`) with its real status; a plain post gets a 303 or a small HTML page. The only URL
parameters left are navigation (`next`, a location id) and one allow-listed code
(`/sign-in?link=invalid` after a used email link), whose sentence lives on the page.

## Alternatives considered

- **Business type check in SQL only** (trigger plus error mapping). Race-proof, but the settings
  form would learn about the lock only from a constraint name. Kept as the backstop.
- **Store working hours as UTC instants or offsets.** Wrong twice a year by an hour. Rejected by
  the design.
- **A Temporal polyfill now.** A new dependency for one function Intl already answers; Phase 4 may
  add it with the slot engine if the property tests want it. Deferred.
- **A tenant-wide "allow free text" switch** instead of a per-field override. Coarser and harder to
  audit per field. Rejected.
- **Generic `entity_id` on custom values** (no foreign key). Simpler, but a value could outlive or
  point at the wrong record. Rejected for per-entity columns with composite keys.

## Consequences

- Positive: every configuration table is covered by RLS, the CI check and the generated isolation
  suite; DST behaviour is pinned before slots exist; the type lock cannot be raced.
- Costs: replacing a schedule is delete-and-insert under a team member row lock; the auth forms
  need JavaScript (their reducer runs in the browser), while the routes still answer plain posts.
- Revisit when: Phase 4 builds `computeSlots` on `resolveWorkingDay` and folds buffers and travel
  into `blocked`; Phase 5 adds client custom values and public reads; Phase 7 turns
  `daily_capacity_rules` into per-date `daily_capacity` rows.
