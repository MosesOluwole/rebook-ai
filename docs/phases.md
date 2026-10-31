# Rebook AI — MVP Build Phases

> Repo copy of the Claude Doc "Rebook AI — MVP Build Phases" (https://claude.ai/artifact/LGC9oqdVd7Dhm7mK9wQKSP), exported 29 Oct 2026.
> The agents in `.claude/agents/` read this file. When the Claude Doc changes, update this file in the same PR.

## How phases work

Ten phases take Rebook AI from an empty repo to the 11 December launch, and no phase starts until the previous one has passed its gate. The source of truth for design decisions is [`docs/architecture.md`](./architecture.md) (System Design v1.0); this doc is the execution order.

**The gate.** A phase is complete only when all four hold:

1. Every acceptance criterion is ticked, each with evidence: a test name, command output or a screenshot.
2. The `rebook-test-engineer` agent has run the full suite and reported green, with no skipped or weakened tests.
3. The `rebook-code-reviewer` agent reports zero blocking findings.
4. Moses has reviewed the diff and committed. Agents never run `git commit`.

**Definition of done, applied to every phase.**

- `pnpm typecheck` (TypeScript strict, no `any` outside documented exceptions), `pnpm lint` with zero warnings, and `pnpm test` all pass.
- Migrations apply cleanly to an empty database and on top of the previous phase's schema; every new tenant-owned table has `tenant_id`, RLS policies and composite FKs.
- The tenant isolation suite passes and covers every table and route added in the phase.
- No secrets, real customer data or PII in code, logs, fixtures or test output.
- No unchecked TODOs; anything deferred is written in the phase's notes with a reason.
- `docs/` updated for anything a future developer needs (schema, decisions, setup).

**Working loop inside a phase.** Write a short plan in the PR description, implement in small reviewable steps, ask the test agent to verify, ask the review agent to review, fix findings, then hand to Moses. One branch and one PR per phase.

**Schedule.**

| Phase | Target finish |
| --- | --- |
| 0. Setup, tooling, agents | Sat 31 Oct |
| 1. Database foundation | Wed 4 Nov |
| 2. Auth, onboarding, permissions | Sun 8 Nov |
| 3. Services, team, schedules, custom fields | Wed 11 Nov |
| 4. Timed booking engine | Sun 15 Nov |
| 5. Booking pages, invite links, attribution | Thu 19 Nov |
| 6. Worker and email | Sun 22 Nov |
| 7. Enquiries, quotes, date capacity | Sun 29 Nov |
| 8. Back office, export, reporting | Sun 6 Dec |
| 9. Hardening and launch | Fri 11 Dec |

Privacy and legal work for the midwife pilot is parked by decision and must be resolved before Phase 9 puts real client data into production.

## Phase 0 — Project setup, tooling and agents

**Why.** Every later phase depends on a reproducible environment and automated checks. Setting the rules now (strict types, boundaries, CI, agents) is cheaper than retrofitting them across finished code.

**What.**

- Next.js (App Router) + TypeScript strict, pnpm, Node LTS pinned in `.nvmrc` and `package.json` `engines`.
- Folder layout `src/modules/<module>/{domain,application,infrastructure}` plus `src/app` for routes; dependency-cruiser rules that forbid cross-module imports except through each module's `index.ts`, and forbid framework imports in `domain`.
- ESLint (typescript-eslint strict), Prettier, `tsc --noEmit` as `pnpm typecheck`.
- Vitest for unit and integration tests, Playwright for E2E, a test database helper that runs against the local Supabase Postgres.
- Supabase CLI local stack (`supabase start`), Drizzle configured for SQL migrations.
- `.env.example` with placeholders only; env validated at boot with Zod.
- GitHub Actions CI: install, typecheck, lint, unit tests, migrations against a fresh Postgres, integration tests.
- `.claude/agents/rebook-test-engineer.md` and `.claude/agents/rebook-code-reviewer.md` (already created in `~/Documents/rebook-ai`), plus a `CLAUDE.md` with project rules and `docs/phases.md` exported from this doc so the agents can read the acceptance criteria.
- `docs/` with `architecture.md` (the system design), `adr/` for decisions, `setup.md`.

**Acceptance criteria.**

- [ ] A fresh clone runs `pnpm install`, `supabase start`, `pnpm dev` and serves a health page with no manual steps beyond `docs/setup.md`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:e2e` exist and pass on the empty skeleton.
- [ ] A deliberate cross-module import fails `pnpm lint:deps`.
- [ ] Starting the app with a missing required env var fails fast with a readable error.
- [ ] CI runs on every PR and blocks merge on failure.
- [ ] Both agents are invoked by name in Claude Code ("use the `rebook-code-reviewer` subagent to review the skeleton", and the same for `rebook-test-engineer`) and each returns a report in its defined format.
- [ ] ADR-001 records the stack choices from the system design.

## Phase 1 — Database foundation and tenant isolation

**Why.** Tenant isolation is the invariant that cannot be retrofitted. If the roles, RLS and request context are right before any feature exists, every later table inherits them; if not, every later feature is a potential cross-tenant leak.

**What.**

- App tables live in a dedicated `rebook` schema that Supabase's Data API does not expose; `anon` and `authenticated` get no grants on it.
- Roles: `rebook_owner` is the migration role (Supabase's `postgres`) and is never used at runtime. `rebook_authenticator` (LOGIN, NOINHERIT, no table privileges) is what the app and tests connect as. `rebook_app` and `rebook_worker` (NOLOGIN, `NOBYPASSRLS`) hold table privileges and are entered per transaction with `SET LOCAL ROLE`. `rebook_platform` is reserved with no grants. Login passwords are set outside migrations (local setup script; platform secrets in production).
- `withTenant(ctx, fn)`: validates `ctx` with Zod, opens a transaction, runs `SET LOCAL ROLE rebook_app` and `set_config(name, value, true)` for `app.tenant_id`, `app.actor_id`, `app.actor_kind`, `app.request_id` (bind parameters; `SET LOCAL` cannot take them), and passes a branded `TenantTx` handle that repositories require. `withWorkerTenant` does the same as `rebook_worker`.
- Core tables: `tenants`, `tenant_memberships`, `locations`, `audit_logs`, `tenant_feature_flags`, `idempotency_keys`. UUIDv7 primary keys from a tested SQL function (Postgres 17 has no built-in `uuidv7()`), `timestamptz`, `unique (tenant_id, id)`.
- RLS enabled and forced on every table. Policies compare against `(select nullif(current_setting('app.tenant_id', true), '')::uuid)`. The `nullif` matters: once a pooled connection has had the setting, it reads back as an empty string, and casting that to uuid would raise an error instead of returning zero rows.
- `tenants` is readable and insertable only where `id` equals the current tenant (the app generates the id, sets context, then inserts). `tenant_memberships` is also readable where `user_id` equals the current actor, so Phase 2 can list a user's tenants.
- Composite FK pattern `(tenant_id, parent_id) references parent (tenant_id, id)`.
- `audit_logs` append-only: runtime roles get INSERT and SELECT only.
- Extensions `btree_gist`, `pg_trgm`, `citext` as needed, installed in the `extensions` schema.
- Generated isolation test suite: for every tenant-owned table found in the catalogue, tenant A's context sees zero of tenant B's rows and cannot insert rows pointing at tenant B's parents.
- CI schema check: fails if a table in the `rebook` schema lacks `tenant_id` (outside an allow-list), an RLS policy or `FORCE ROW LEVEL SECURITY`, or has any grant to `anon` or `authenticated`.
- ADR-002 records the schema, role and context decisions; `docs/schema.md` generated from migrations plus the invariants table.

**Acceptance criteria.**

- [ ] Migrations apply on an empty database (`pnpm db:reset`) and on top of Phase 0's schema in CI.
- [ ] `anon` and `authenticated` cannot read or write any `rebook` table, and the schema is absent from the Data API config.
- [ ] Connecting as `rebook_authenticator` outside `withTenant` gets permission denied on every `rebook` table.
- [ ] As `rebook_app` with no tenant set, every select on a tenant table returns zero rows without an error.
- [ ] As `rebook_app` with tenant A set, selecting, updating or deleting tenant B's rows affects zero rows.
- [ ] Inserting a child row with tenant A and a tenant B parent fails with a foreign-key error.
- [ ] `UPDATE` or `DELETE` on `audit_logs` as a runtime role fails with a permission error.
- [ ] A repository function cannot be called without the `TenantTx` handle (type error demonstrated in a `@ts-expect-error` test).
- [ ] Adding a test table without RLS, or with a grant to `anon`, makes the CI schema check fail.
- [ ] On one pooled connection, a transaction with no tenant context that runs after one with tenant A sees zero rows and raises no error.
- [ ] The UUIDv7 function returns valid version-7 UUIDs that sort in creation order (tested in SQL).

## Phase 2 — Auth, onboarding and permissions

**Why.** Nothing can be configured or tested end to end until a real business owner can sign up and land in their own workspace. Business type is chosen here because it drives terminology, defaults and the health-data rules for midwives.

**What.**

- **Phase 1 follow-ups, as new migrations (never edit applied ones):** the memberships select policy's actor branch also requires `app.actor_kind = 'user'`; `tenant_memberships.user_id` references `auth.users(id) on delete cascade`; a CI check fails if any migration already on the default branch is modified; time zones are canonicalised in the domain layer with `Intl` before saving (wrong case and legacy aliases converted or rejected by a documented rule, never stored as typed).
- **User context.** `withUserContext(actor, fn)` sets only the actor under `rebook_app` and passes a `UserTx` handle; the only repository accepting `UserTx` is "list my memberships".
- **Slug resolution.** `rebook.resolve_tenant_slug(slug)` is a `SECURITY DEFINER` function with `search_path = ''` that returns only the tenant id (or null), executable by `rebook_app` only. Public pages in Phase 5 reuse it.
- **Authorised tenant context.** `resolveTenantForUser(slug, user)` resolves the slug, checks an active membership via `UserTx`, and returns a branded `AuthorisedTenantContext`. `withTenant` accepts user actors only through that type; registration and invite acceptance have their own constructors.
- **Supabase Auth** via `@supabase/ssr`: email and password, and magic link. Sessions are refreshed in Next.js's request interceptor, and server code verifies the user with Supabase on every request rather than trusting the cookie's session payload.
- **Sign-up, then onboarding.** The auth user lives in Supabase Auth, so this is two steps, not one transaction. Onboarding creates the tenant (name, slug, business type, IANA time zone), default location and owner membership in one `withTenant` transaction with an app-generated tenant id. Slug collisions retry with a suffix on unique violation. A signed-in user with no membership lands on onboarding.
- **Business type** on `tenants`: `event_planner`, `midwife`, `other_timed`. Terminology (client or patient; booking, enquiry or appointment) and `isHealthBusiness` are derived in domain code, not stored separately.
- **Roles and permissions.** `owner` and `staff`; `can(role, permission)` checked in every application command. Owner-only: invite member, revoke member, toggle flag, update business settings.
- **Invitations** in our own `tenant_invitations` table (email, role, token hash, expiry, accepted and revoked timestamps), not Supabase admin invites, which need the service-role key. The link carries slug and token; accepting requires a signed-in user whose verified email matches, and creates the membership idempotently.
- **Feature flags** read server-side with `requireFlag(tenant, flag)`; changes audited in the same transaction.
- **Back-office shell** at `/app/[slug]`: navigation, tenant switcher listing only the user's tenants, empty dashboard in the business type's words, mobile layout at 375 px.
- The service-role key is never used in application code.

**Acceptance criteria.**

- [ ] Phase 1 follow-ups: a `customer` actor whose id matches a user sees no memberships; a membership for a non-existent user fails the foreign key; modifying an existing migration fails CI; wrong-case and alias time zones follow the documented rule and are never stored as typed.
- [ ] A new owner signs up, completes onboarding as "Midwife" or "Event planner", and lands on a dashboard using that business type's words.
- [ ] A user who abandons onboarding returns to it at next sign-in, and no partial tenant, location or membership rows exist.
- [ ] Two businesses with the same name get different slugs without errors.
- [ ] A member of tenant A requesting tenant B's slug gets the same 404 as a slug that does not exist.
- [ ] `withTenant` cannot be called for a user actor without an `AuthorisedTenantContext` (`@ts-expect-error` test).
- [ ] A `staff` user calling any owner-only command gets a typed permission error, tested for every owner-only command.
- [ ] An invite is accepted only by a signed-in user with the matching verified email; expired, revoked or already-used invites return 404; accepting twice creates one membership.
- [ ] Toggling a feature flag writes an `audit_logs` row with actor and before/after values.
- [ ] Signed-out access to back-office routes redirects to sign-in; API routes return 401; a forged or expired session cookie is rejected.
- [ ] CI fails if the service-role key is referenced anywhere under `src/`.
- [ ] Playwright, desktop and 375 px: sign up, onboard, sign out, sign in, invite, accept, switch tenant.

## Phase 3 — Services, team, schedules and custom fields

**Why.** Availability and enquiries are computed from this configuration, so it must be complete and validated before the booking engine exists. Getting buffers, travel time and time zones right here prevents wrong slots later.

**What.**

- `services`: name, `booking_mode` (`timed` or `request`), duration, buffer before and after, price as `numeric(12,2)` plus currency, location type (`clinic`, `client_home`, `video`, `venue`), repeat interval, published flag.
- `team_members` linked to memberships, with `staff_services` eligibility.
- `working_hours` (weekly rules in wall-clock time per location), breaks, `availability_exceptions` (time off, closures).
- Midwife service areas: postcode district list per team member, and travel minutes added before and after home visits.
- `custom_field_definitions` and `custom_field_values` for clients and services, validated by a Zod schema built from each definition. For health business types, free-text field types are disabled by default and show a warning if enabled.
- `daily_capacity_rules` for request-mode services (events per date per team member), table only; enforcement arrives in Phase 7.
- Back-office screens for all of the above, usable at 375 px.

**Acceptance criteria.**

- [ ] Invalid configuration is rejected server-side with field-level errors: negative durations, overlapping working-hour ranges on one day, buffers over 4 hours, price with more than 2 decimals, unknown currency.
- [ ] A service cannot be assigned to a team member from another tenant (composite FK test).
- [ ] Working hours entered as 09:00–17:00 Europe/London are stored as wall-clock rules and resolve to the correct UTC instants on both sides of a DST change.
- [ ] A health business cannot create a free-text custom field without an explicit override, and the override is audited.
- [ ] Custom field values failing their definition's type or options are rejected.
- [ ] Unpublishing a service hides it from public reads while keeping existing bookings intact.
- [ ] Isolation suite extended to every new table and route; all pass.
- [ ] Playwright at 375 px: create a service, add a team member, set hours, add time off, define a custom field.

## Phase 4 — Timed booking engine

**Why.** This is the core promise to a midwife: a slot shown is real, and no two clients ever get the same time. Correctness rests on the database constraint, so it is built and proven before any public page exposes it.

**What.**

- `bookings` table (the design doc's `appointments`) with `blocked tstzrange` covering buffers and travel, `price_snapshot`, immutable `source` and `campaign_send_id`, `version`, and the `no_overlap` exclusion constraint on active statuses.
- `BEFORE UPDATE` trigger rejecting changes to `source` or `campaign_send_id`.
- `booking_events` appended in the same transaction as every state change.
- Pure `computeSlots(rules, busy, settings, range)` in `domain`, with no I/O and no clock access (time passed in).
- `AvailabilityService`: one indexed range query plus `computeSlots`; max 31-day range.
- `BookingService.create`, `reschedule`, `cancel`, `complete`, `markNoShow`: idempotency key claim, availability re-check, insert or update, map SQLSTATE 23P01 to a 409 with the next three slots.
- Cut-off windows for client cancel and reschedule, evaluated in the location's time zone; staff override with an audited reason.
- Manage-booking links: 128-bit random tokens stored as SHA-256 hashes, scoped to one booking, with expiry and revocation.

**Acceptance criteria.**

- [ ] 50 concurrent `create` calls for the same slot and team member produce exactly 1 booking and 49 typed conflict errors, repeated 20 times in CI without a flake.
- [ ] Replaying a `create` with the same idempotency key returns the original response and writes no second row; same key with a different body returns 422.
- [ ] Property-based tests: no returned slot overlaps a busy range, breaks, time off, buffers or travel time; every slot lies inside working hours.
- [ ] DST tests for Europe/London on the last Sundays of March and October 2026 and 2027: no slot at a non-existent local time; ambiguous times resolve to the earlier instant.
- [ ] Updating `source` on a booking raises an error from the trigger.
- [ ] Cancelling releases the slot: a new booking for the same time succeeds.
- [ ] Reschedule with a stale `version` fails without changing the row.
- [ ] A manage link for booking X cannot read or change booking Y; expired and revoked links return 404.
- [ ] Availability p95 under 300 ms on a seeded tenant with 5 team members and 2,000 bookings (measured locally, numbers recorded).

## Phase 5 — Booking pages, midwife invite links and attribution

**Why.** This is the first surface clients touch. Midwives need invite-only access so their clients' bookings never pass through a public page, and every booking needs its source recorded at creation because it can never be corrected later.

**What.**

- Public booking page per tenant at `/{slug}` for non-health businesses: service list, team member choice, date and time, client details, confirmation, manage link. Basic branding: logo, primary colour, intro, policies.
- Midwife pages: unlisted, `noindex` meta and `X-Robots-Tag` header, and reachable only with a valid invite token.
- Client invites: the midwife adds a client and generates a personal link (hashed token, expiry, tied to that client and that midwife's services). Booking through it attaches to that client and records `source = invite_link`.
- Shared unlisted link for a midwife, off by default behind a flag.
- Home-visit bookings ask for the client's postcode and reject postcodes outside the midwife's areas before showing slots.
- Client matching for public bookings (non-health): propose, never merge, never overwrite stored details.
- Source set by entry point only (`booking_page`, `invite_link`, `staff`, `customer_link`); UTM and referrer captured into a signed short-lived cookie and copied onto the booking.
- Rate limits on public endpoints (per IP and per tenant), CSRF-safe booking POSTs, Zod validation on every input.

**Acceptance criteria.**

- [ ] A client books, reschedules and cancels through the public page on desktop and at 375 px (Playwright).
- [ ] A midwife's page returns 404 without a valid invite token, and its responses carry `noindex`.
- [ ] An invite link for client A cannot be used to book as client B or to view A's bookings; expired and revoked invites return 404.
- [ ] A home-visit postcode outside the midwife's areas is rejected before slots are shown.
- [ ] Every booking path writes the correct `source`, asserted in one parameterised test per path.
- [ ] A public booking with an existing client's email but a different name creates a new client and a duplicate suggestion; the existing client's stored details are unchanged.
- [ ] Exceeding the rate limit returns 429; booking still works for other IPs.
- [ ] No client personal data appears in server logs during the E2E run (log scan in CI).

## Phase 6 — Worker and email

**Why.** A booking nobody is told about is a no-show. Emails must go out exactly once, never after a cancellation, and never to a midwife's client in a way that reveals health information or markets to them.

**What.**

- graphile-worker in its own process (`pnpm worker`), connecting as `rebook_worker`, setting tenant context per job and asserting the target row's tenant.
- Jobs enqueued with `graphile_worker.add_job()` inside the same transaction as the state change, using `job_key` for dedupe.
- `MessageChannel` interface with a Resend adapter and a dev adapter that writes to `message_sends` with `provider = 'dev'`.
- Send pipeline: reload state, run `canContact`, insert `message_sends` with dedupe key, call the provider with the same key as its idempotency key, record status; webhooks verified before parsing.
- `canContact(client, channel, purpose)`: for health business types, purpose `marketing` always returns `not_allowed` regardless of consent or settings.
- Templates: confirmation, reminder (one configurable offset), reschedule, cancellation. Neutral subjects and preview text for health business types ("Your appointment with Jane, Tue 10:00").
- Per-client "pause all messages" switch; paused sends are recorded as suppressed with the reason.
- Message log in the back office showing status and suppression reasons.

**Acceptance criteria.**

- [ ] Creating a booking enqueues exactly one confirmation; rolling back the transaction enqueues none.
- [ ] Running the send job 3 times for the same message produces one `message_sends` row and one provider call.
- [ ] Killing the worker between insert and provider call, then retrying, still yields one delivered email (provider idempotency verified against the dev adapter's call log).
- [ ] A reminder for a cancelled or rescheduled booking is suppressed with a recorded reason; the rescheduled booking gets a new reminder.
- [ ] For a midwife tenant, any attempt to send a marketing-purpose message is suppressed, tested through every code path that can send.
- [ ] No midwife email subject or preview contains service names, clinical words or custom field values (snapshot tests on every template).
- [ ] Pausing a client suppresses all queued and future sends until unpaused.
- [ ] A webhook with a bad signature is rejected with 401 and no state change.

## Phase 7 — Enquiries, quotes and date capacity for event planners

**Why.** Event planners don't sell time slots; they accept or decline dates. The request-then-confirm flow, with a hard limit on events per date, is what makes Rebook usable for them, and it must hold up when two clients accept the last date at once.

**What.**

- Enquiry form for request-mode services: date or date range, plus the service's custom fields (event type, guest count, venue or postcode, budget, notes).
- Booking states: `requested`, `quoted`, `accepted`, `confirmed`, `completed`, `declined`, `expired`, `cancelled`, with an explicit transition table enforced in the domain layer.
- Quotes: amount, currency, terms, expiry (default 7 days). The client accepts or declines through a tokenised link.
- `daily_capacity` rows per (tenant, team member, date) with a check constraint `used <= capacity`; acceptance increments it in the same transaction; decline, expiry and cancel decrement it.
- Expiry job releases expired quotes.
- "Deposit received" action moves `accepted` to `confirmed`, is audited, and schedules the balance-due reminder from the planner's due date.
- Emails: enquiry received (to planner and client), quote sent, quote accepted, confirmed, balance due, declined.
- Back office: enquiry inbox, enquiry detail with quote form, date view showing capacity used, all at 375 px.

**Acceptance criteria.**

- [ ] Every allowed transition succeeds and every disallowed one returns a typed error, covered by a table-driven test of the full state matrix.
- [ ] With capacity 1, two clients accepting quotes for the same date concurrently produce exactly one `accepted` booking; the other gets a clear "date no longer available" response. Repeated 20 times without a flake.
- [ ] An expired quote can no longer be accepted, and its capacity is released by the job.
- [ ] Declining or cancelling an accepted booking decrements capacity exactly once, even if the action is retried.
- [ ] Marking a deposit received twice is idempotent and writes one audit entry.
- [ ] A quote link for booking X cannot act on booking Y; expired and revoked links return 404.
- [ ] Playwright: client submits an enquiry, planner quotes, client accepts, planner marks deposit received, booking shows as confirmed; desktop and 375 px.

## Phase 8 — Back office completion, export and reporting

**Why.** Pilots will run their week from a phone, so the daily screens must be complete there. Export proves the promise that businesses own their data, and source counts give the first evidence of where bookings come from.

**What.**

- Calendar day view per team member, booking detail with history from `booking_events`, client list with search and pagination, client profile with bookings and source.
- Health business access rules: "team members see only their own clients" on by default; every client profile view writes an audit entry.
- Staff-created bookings (`source = staff`) from the calendar.
- CSV export of clients and bookings as a background job, with formula-injection neutralised, delivered by an authenticated route that issues a 5-minute signed URL and audits the download.
- Reporting page: bookings and enquiries by source over a chosen period, with the counting rule shown beside each number.
- Opt-in anniversary nudge for event planners only (365 days after a completed event, marketing consent required, frequency cap).
- Scripted import (`pnpm import:clients --tenant --file --dry-run`) for pilots: validates and reports before writing; imported clients default to no marketing consent.

**Acceptance criteria.**

- [ ] Day view, booking detail and client profile pass Playwright checks at 375 px: no horizontal scroll, all actions reachable.
- [ ] A midwife practice staff member cannot open another team member's client by URL; the attempt returns 404 and is audited.
- [ ] Exported CSV row counts match database counts for the tenant; cells starting with `=`, `+`, `-` or `@` are neutralised; another tenant's data never appears (isolation test on export).
- [ ] An export link used after 5 minutes, or by a different user, is refused.
- [ ] Source counts match a hand-computed fixture of 100 seeded bookings.
- [ ] No anniversary nudge can be scheduled for a health business or a client without marketing consent.
- [ ] The import script's dry run writes nothing; a real run is idempotent when re-run on the same file.

## Phase 9 — Hardening, deployment and pilot launch

**Why.** Working on a laptop is not the same as safe in production. This phase proves both critical journeys in the real environment, makes failures visible, and gets the pilots onboarded on solid ground.

**What.**

- Production stack in London: Vercel (web), Supabase Pro eu-west-2 (database, auth, storage), Fly.io (worker, 2 instances), Resend with verified sending domain.
- Staging environment mirroring production with providers in test mode; migrations run once per deploy from CI as `rebook_owner`.
- Sentry for errors, structured logs with `request_id` and `tenant_id` and no PII, alerts for queue lag over 5 minutes, failed jobs, error-rate spikes and unusual exclusion-constraint conflicts.
- Backups confirmed and one restore rehearsed into staging.
- Security pass: headers (CSP, HSTS), dependency audit, secrets only in platform stores, rate limits verified in production.
- Runbooks: double-booking report, cross-tenant access report, email outage, stuck job, restore from backup.
- Critical journeys as Playwright suites against staging: (1) midwife registers, adds a client, sends an invite, client books a home visit, receives confirmation and reminder, reschedules; (2) planner registers, client enquires, planner quotes, client accepts, deposit marked, confirmation and balance-due reminder sent.
- Pilot onboarding: scripted import of each pilot's clients, walkthrough, support contact.

**Acceptance criteria.**

- [ ] Both critical journeys pass against staging, then against production with test tenants, 3 consecutive runs each.
- [ ] Full isolation suite passes against staging, connected through the Supabase transaction-mode pooler as `rebook_authenticator`.
- [ ] With email confirmation enabled on staging, sign-up shows "check your email", the confirmation link signs the user in once, and a reused link is rejected.
- [ ] A forged `X-Forwarded-For` and a forged `x-vercel-forwarded-for` sent through Vercel do not change the rate-limit key; the stored key matches the platform's value.
- [ ] Invite and sign-in links generated on staging and production use `APP_ORIGIN`, and Supabase's Site URL matches it.
- [ ] A forced error in production appears in Sentry within 1 minute with tenant and request IDs and no client personal data.
- [ ] A restore from backup into staging completes and the restored data passes integrity checks; time taken is recorded.
- [ ] Security headers verified with a scanner; `pnpm audit` has no high or critical findings.
- [ ] Privacy and legal items for the midwife pilot are resolved before any real client record is created in production.
- [ ] Both pilots have signed in, imported their clients and taken at least one real booking.
- [ ] Known limitations and post-launch backlog written in `docs/known-limitations.md`.
