# Rebook AI — System Design v1.0

> Repo copy of the Claude Doc "Rebook AI — System Design v1.0" (https://claude.ai/artifact/GnuYTVesHRbS2mvwRb3pG3), exported 29 Oct 2026.
> The agents in `.claude/agents/` read this file. When the Claude Doc changes, update this file in the same PR.
> Section numbers used in cross-references: 1 Context, 2 Requirements, 3 Architecture, 4 Tenancy, 5 Data model, 6 Booking engine, 7 Customer identity, 8 Jobs and messaging, 9 AI, 10 Attribution/import/export/widget, 11 Reliability, 12 Alternatives and decisions, 13 Delivery.

## 1. Context and scope

Rebook AI ships as one Next.js modular monolith on one Postgres database, with a separate long-running worker, and correctness is enforced in the database rather than in application code. This design implements Master Specification v1.2 (https://claude.ai/artifact/TjMdqqYeg9pB4SgZEbaVKX); where the spec is silent or risky, this doc decides and flags it (section 12).

**Objective.** Any business that takes bookings (a salon, a cake baker, an event planner, a tutor) can import their clients, take bookings from a page, widget or AI chat, and see attributed rebooking revenue, with no double bookings, no cross-tenant leaks and no duplicate emails.

**Business types and booking modes.** Rebook AI is not a beauty product: it serves any business that needs bookings, and beauty is only the first market. Those businesses book in three different ways, so every service carries a `booking_mode` from day one and new modes are additive, not a rewrite.

| Mode | Example businesses | How availability works | What gets booked | In MVP (11 Dec) |
| --- | --- | --- | --- | --- |
| Timed appointment | Private midwives, salons, barbers, tutors, therapists, photographers, trainers | A team member's free time on a slot grid, with buffers and travel time; exclusion constraint prevents overlaps | A start and end time with a team member, at a clinic, the client's home or by video | Yes; midwives are a launch pilot |
| Request then confirm | Event planners, venues, wedding services, bespoke work | The business reviews an enquiry, may quote, then accepts; accepted bookings consume per-date capacity | A date or date range, confirmed by the business | Yes; event planners are a launch pilot; deposits tracked manually |
| Dated order with daily capacity | Cake bakers, florists, caterers, makers | Capacity per day (orders or units), minimum lead time, blackout dates, optional collection or delivery window | A fulfilment date plus order details (size, flavour, message) | No, January |

**How each mode stays correct.** Timed bookings rely on the exclusion constraint. Dated orders use a `daily_capacity` row per (tenant, location, date) with a check constraint `used <= capacity`, incremented in the booking transaction, so two customers cannot take the last slot of the day. Request bookings start in `requested` status, outside the exclusion set, and only `accepted` holds the date.

**What we do now so the other modes are cheap later.**

- `services.booking_mode` enum exists in the MVP schema with `timed` and request enabled; dated orders come in January.
- Code uses generic names (`bookings`, `team_members`); this doc's "appointment" and "staff" mean those.
- Each tenant picks a business type at onboarding, which sets its terminology (appointment, order or event; stylist, baker or planner) and example services. No UI text, email or template hardcodes "salon".
- Rebooking generalises as a repeat interval per service: a 365-day interval on a birthday cake becomes next year's birthday reminder; a 6-week interval on a haircut is the classic rebook.
- Custom fields ship in the MVP for event enquiries, and later carry baker order details (flavour, size, message).

**Launch verticals.** The MVP pilots with two business types: event planners (request then confirm) and private midwives (timed appointments, invite-only). Salons and other timed businesses run on the same engine but are not the pilot focus.

**Event planners.**

- Enquiry form per service: date or date range, event type, guest count, venue or postcode, budget, notes. These are custom fields, so custom fields move into the MVP.
- States: `requested`, `quoted`, `accepted`, `confirmed`, `completed`, or `declined`, `expired`, `cancelled`. Only `accepted` and `confirmed` consume date capacity.
- Quote: amount, currency, terms and expiry (default 7 days). The customer accepts through a tokenised link; an expiry job releases the date.
- Date capacity: events per date per planner, held in `daily_capacity` and checked in the same transaction as acceptance, so two customers cannot take the last date.
- Deposits stay outside Rebook: the planner marks "deposit received", which moves the booking to `confirmed` and is audited. A balance-due reminder is scheduled from the due date the planner sets.
- Repeat business: opt-in anniversary nudge (365-day interval), marketing consent required.

**Private midwives.**

- Invite-only access. Midwife booking pages are unlisted and served `noindex`. The midwife adds the client (or imports them) and sends a personal invite link: a hashed, expiring token tied to that client and that midwife's services. Bookings through it record `source = invite_link`. A shared unlisted link is available but off by default.
- Because the invite already identifies the client, there is no public contact-matching step and no duplicate-client risk from public input.
- Services: antenatal, postnatal, home visit and video, each with a location type (clinic, client's home, video). Home visits are limited to the midwife's postcode areas, with travel time before and after folded into the `blocked` range.
- Data roles: the midwife is the controller and Rebook is the processor under a data processing agreement. The midwife's Article 9 condition is hers to determine; Rebook documents a DPIA for its processing. Legal review is required before the first real client record.
- Data minimisation: no clinical fields in the MVP (no due date, gestation or notes). Custom fields for this business type exclude free text by default; clinical records stay in the midwife's own system.
- Messaging: neutral email subjects and previews ("Your appointment with Jane, Tue 10:00"). No marketing or automated rebooking for health business types, enforced inside `canContact` rather than by a setting. A per-client "pause all messages" control. AI chat is unavailable for this business type.
- Access: "team members see only their own clients" defaults on for health business types, and every view of a client profile is audit-logged.
- Terminology defaults to "client", configurable to "patient".

**Design principles, in priority order.**

1. **Invariants live in Postgres.** Tenant isolation (RLS + composite FKs), no overlaps (exclusion constraint), immutable attribution (trigger), idempotency (unique keys). Application bugs cannot violate them.
2. **One write path per aggregate.** Page, widget, staff UI, AI and import all call the same domain service. No surface writes tables directly.
3. **Every side effect is transactional or idempotent.** Jobs are enqueued in the same transaction as the state change; every external send carries a dedupe key.
4. **The model never commits.** The AI proposes; a human click commits through the booking service.
5. **Boring at this scale.** Projected load (section 2) fits one Postgres instance with large headroom, so we spend complexity on correctness, not distribution.

**Non-goals for MVP.** Payments and deposits, SMS, resource and group scheduling, marketplace discovery, multi-region, customer accounts with passwords, native mobile apps.

**Status.** Proposed. Needs owner sign-off on the decisions in section 12 before Stage 2 starts.

## 2. Requirements, SLOs and capacity

Peak load at 1,000 tenants is about 6 booking writes/s and 120 availability reads/s, two orders of magnitude below what one Postgres instance handles, so no sharding, caching tier or queue broker is justified.

**Capacity model (planning assumptions, to revisit at 500 tenants).**

| Quantity | Assumption | Derived |
| --- | --- | --- |
| Tenants, year 1 | 1,000 | 5,000 staff (5 per tenant) |
| Appointments | 30 per staff per week | 150k/week, ~21k/day |
| Booking writes | 10 busy hours, 10x peak factor | ~0.6/s average, ~6/s peak |
| Availability reads | 20 reads per booking | ~120/s peak |
| Emails | 3 per appointment + rebooking | ~70k/day |
| AI chat turns | 15% of bookings via chat, 8 turns each | ~25k turns/day |
| Storage | ~2 KB per appointment incl. events | < 15 GB/year with audit logs |

**Service level objectives (measured monthly).**

| SLI | Target |
| --- | --- |
| Public booking page and widget availability | 99.9% (43 min/month error budget) |
| Availability lookup latency, p95 | < 300 ms server time |
| Booking commit latency, p95 | < 500 ms server time |
| Transactional email handed to provider within 5 min of due time | 99% |
| AI assistant first token, p95 | < 2.5 s |
| Back office page interactive on mid-range phone, 4G | < 2.5 s LCP |

**Hard invariants (not SLOs: any violation is a Sev-1).** Zero double bookings for a staff member. Zero cross-tenant reads or writes. Zero marketing emails to a customer without consent. Zero duplicate sends of the same message. Booking source never changes after insert.

**Cost envelope.** Infrastructure under GBP 300/month at 1,000 tenants excluding LLM tokens; LLM cost tracked per tenant and capped per plan.

## 3. Architecture overview

Four client surfaces share one set of application services inside a Next.js monolith; every request opens one tenant-scoped transaction into Supabase Postgres, and a separate worker drains jobs that were written in those same transactions.

```
 [Page and widget]   [AI chat]   [Back office]   [Platform admin]
   public, rate-     proposal     staff,          grant-gated,
   limited           cards only   mobile-first    audited
         \               |             |              /
  +---------------- Next.js modular monolith (Vercel, London) ----------------+
  |  Thin adapters: route handlers and server actions parse with Zod,         |
  |  call services                                                             |
  |  [Booking]          [CRM and data]        [Messaging]       [AI assistant]-+--> Anthropic API
  |  computeSlots,      match, merge,         canContact,       tool loop,     |    (behind LlmProvider)
  |  commit             import                templates         proposals      |
  +------------------------------------+---------------------------------------+
                                       | withTenant, rebook_app role
 [Worker on Fly.io] <------> [Supabase eu-west-2: Postgres, Auth, Storage]
  emails and rebooking         RLS on every table, composite tenant FKs
  import and export jobs       exclusion constraint: no overlapping bookings
  idempotent handlers          triggers: immutable source, append-only audit
        |                      graphile_worker jobs, enqueued in-transaction
        v
 [Resend] (behind MessageChannel)
 External providers have dev adapters locally.
```

The database is the source of truth: isolation, no-overlap and attribution rules live there, so no surface or job can bypass them. Providers sit behind interfaces with labelled development adapters, which keeps local runs and tests free of real credentials.

**Module boundaries.** Booking owns services, staff, availability and appointments. CRM owns customers, merges, custom fields, import and export. Messaging owns templates, consent, sends and rebooking. AI owns conversations and tools, and calls Booking and CRM only through their public services. Analytics reads; it never writes to another module's tables.

**Read path for availability.** Adapter, then `AvailabilityService`, then one indexed range query and the pure `computeSlots` function. No cache layer at MVP scale (section 2).

## 4. Tenancy, identity and authorisation

Every database statement runs inside a transaction that has set its tenant and actor, under a Postgres role that cannot bypass RLS; this is the single most important decision in the design, because Drizzle connecting as the table owner would silently skip every policy.

**Database roles.**

| Role | Used by | RLS | Notes |
| --- | --- | --- | --- |
| `rebook_owner` | Migrations only | Owns tables | Never used at runtime |
| `rebook_app` | Web request handlers | Enforced (`NOBYPASSRLS`) | Can only see rows where `tenant_id = app.tenant_id` |
| `rebook_worker` | Job worker | Enforced | Sets tenant context per job from the job payload, re-verified against the row |
| `rebook_platform` | Platform admin console | Enforced, with grant policy | Reads tenant data only where an active `support_access_grants` row exists |

**Request context.** A single helper, `withTenant(ctx, fn)`, opens a transaction and runs `SET LOCAL app.tenant_id`, `app.actor_id`, `app.actor_kind` and `app.request_id` before `fn`. Repositories accept only that transaction handle, so code that forgets the context does not type-check. Policies read `current_setting('app.tenant_id', true)::uuid`; a missing setting yields NULL and matches nothing (fail closed).

**How the tenant is resolved, per surface.**

- Back office: Supabase Auth session cookie gives `user_id`; tenant comes from the URL slug and must match an active `tenant_memberships` row. Never from a header or body.
- Public page and widget: tenant from the slug or the widget's public key, resolved server-side; the actor is `anonymous`.
- Customer magic links: tenant and appointment from the hashed token row.
- AI chat: tenant is bound to the conversation at creation and stored server-side; tool arguments never carry `tenant_id`.
- Jobs: tenant from the job payload, and the worker asserts the target row's `tenant_id` equals it before acting.

**Authorisation.** RLS answers "which tenant"; a permission matrix in the domain layer answers "which action". Each command declares its permission (`appointments.cancel`, `customers.merge`, `exports.create`, `flags.update`) and a `can(role, permission)` table maps roles to permissions. Practitioners additionally get a row filter to their own appointments where the tenant setting requires it.

**Customers have no login in MVP.** The spec lists a customer role; this design implements it as scoped, hashed, expiring tokens (manage-booking links and email one-time codes), not Supabase Auth users. This avoids password resets and account takeover for people who book twice a year.

**Platform support access.** A support engineer requests a grant; the owner sees it in the back office and can revoke it; it expires after at most 72 hours. Postgres triggers do not fire on SELECT, so support reads go only through an admin API that writes an `audit_logs` row in the same transaction as each read; the `rebook_platform` role has no other route to tenant rows.

**Isolation tests.** A generated test suite iterates every tenant-scoped table and every route handler with tenant A's session and tenant B's IDs, and asserts zero rows or 404. CI fails if a new table lacks `tenant_id`, an RLS policy, or the composite FK.

## 5. Data model and invariants

The schema keeps the spec's tables and adds four that the design depends on: `outbox`, `message_sends`, `slot_holds` (reserved, unused in MVP) and `appointment_events`; every invariant below is a database object with a migration and a test.

**Conventions.** UUIDv7 primary keys (time-ordered, index-friendly). Every tenant-owned table has `tenant_id uuid not null`, a `unique (tenant_id, id)`, and child FKs written as `foreign key (tenant_id, parent_id) references parent (tenant_id, id)`, so a row can never point into another tenant. Money is `numeric(12,2)` plus `char(3)` currency. Timestamps are `timestamptz`; time zones are IANA names on `tenants` (default) and `locations` (authoritative). Soft delete only where retention rules require it (`customers`, `appointments`); everything else hard-deletes.

**The appointment row** (implemented as `bookings`; see section 1).

```sql
create table appointments (
  id               uuid primary key,
  tenant_id        uuid not null references tenants(id),
  location_id      uuid not null,
  staff_id         uuid not null,
  service_id       uuid not null,
  customer_id      uuid not null,
  status           appointment_status not null,      -- pending|confirmed|completed|cancelled|no_show
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  blocked          tstzrange not null,               -- [starts_at - buffer_before, ends_at + buffer_after)
  price_snapshot   numeric(12,2) not null,
  currency         char(3) not null,
  source           booking_source not null,          -- immutable
  campaign_send_id uuid,                             -- immutable, set when booked via a rebooking link
  referrer         text,
  utm              jsonb,
  created_via_actor jsonb not null,                  -- {kind, id}
  version          int not null default 1,           -- optimistic concurrency for edits
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, staff_id)    references staff (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, service_id)  references services (tenant_id, id),
  constraint no_overlap exclude using gist (
    tenant_id with =, staff_id with =, blocked with &&
  ) where (status in ('pending', 'confirmed'))
);
```

**Invariants and how each is enforced.**

| Invariant | Enforcement | Test |
| --- | --- | --- |
| No overlapping active appointments per staff | `no_overlap` exclusion constraint (needs `btree_gist`) | 50 parallel inserts for one slot; exactly 1 succeeds |
| No cross-tenant references | Composite FKs on every child table | Insert with tenant A id + tenant B parent fails |
| No cross-tenant reads | RLS on every table, `rebook_app` role | Generated suite per table and route |
| Source and campaign never change | `BEFORE UPDATE` trigger raises if `source` or `campaign_send_id` differ | Update attempt raises |
| Revenue figures stable over price changes | `price_snapshot` copied at booking | Change service price; report unchanged |
| One send per logical message | `unique (tenant_id, dedupe_key)` on `message_sends` | Run job twice; one row, one provider call |
| One booking per client retry | `unique (tenant_id, scope, key)` on `idempotency_keys` | Replay request; same response, one row |
| Customers not unique on contact | No unique index on email or phone; trigram index for matching | Two customers share a phone |

**Appointment history.** Status changes and reschedules append to `appointment_events` (event type, before/after, actor) in the same transaction. Analytics read events, so a reschedule never loses its original source or booked time.

**Custom fields.** `custom_field_definitions` (entity, key, type, options, required) plus `custom_field_values` keyed by (tenant, entity, entity_id, definition). Values are validated by a Zod schema built from the definition at write time. No EAV queries in hot paths; the CRM list pivots only the fields the user has chosen to show.

`docs/schema.md` is generated from the migrations plus a hand-written invariants section that mirrors the table above.

## 6. Booking engine

Availability is computed on read from persisted rules, and correctness at commit rests on the exclusion constraint, not on the read: two customers may both see 14:00, exactly one gets it, and the other gets three alternatives in the same response.

**Availability algorithm.** Input: tenant, location, service, optional staff, date range (max 31 days). For each eligible staff member and each local date:

1. Expand weekly `working_hours` for that local date into wall-clock intervals, then convert to UTC with the location's IANA zone (Temporal API polyfill). A wall time that does not exist (spring-forward gap) is dropped; an ambiguous time (autumn fall-back) resolves to the earlier instant.
2. Subtract breaks and `availability_exceptions` (time off, closures).
3. Subtract the `blocked` ranges of active appointments, fetched in one range query using a GiST index on `(tenant_id, staff_id, blocked)`.
4. Subtract the booking notice window (e.g. no bookings within 2 hours) and anything beyond the max-advance horizon.
5. Walk each free interval on a slot grid (tenant setting, default 15 min) and emit a start `t` where `[t - buffer_before, t + duration + buffer_after)` fits entirely.
6. For "any staff", union per-staff slots and keep a candidate staff list per slot; assignment happens at commit using a deterministic policy (least booked that day, then staff order).

Cost is O(staff x days x intervals), roughly 5 x 31 x 20 per request, so no slot cache. Results return UTC instants plus the location zone; the client renders local time. A pure function, `computeSlots(rules, busy, settings, range)`, holds all of this and carries the property-based and DST tests (UK transitions on the last Sunday of March and October).

**Commit path (`BookingService.create`).** One transaction under `withTenant`:

1. Claim the idempotency key: `insert ... on conflict do nothing`; if it exists with the same request hash, return the stored response; different hash returns 422.
2. Load service, staff eligibility, booking rules (cut-off, patch test or consultation prerequisite) and re-run `computeSlots` for that one slot.
3. Match or create the customer (section 7; never merges).
4. Insert the appointment with `source`, `price_snapshot`, `blocked`. If the exclusion constraint fires (SQLSTATE 23P01), roll back and return 409 with the next three slots.
5. Insert `appointment_events` and the outbox rows (confirmation email, reminder schedule) in the same transaction.
6. Commit, then store the response against the idempotency key. Only now does any surface say "confirmed".

Isolation level is READ COMMITTED; the exclusion constraint makes SERIALIZABLE unnecessary and avoids retry storms.

**Reschedule and cancel.** Reschedule is an update of `starts_at`, `ends_at`, `blocked` guarded by `version` (optimistic concurrency) and the same constraint; it bumps the reminder dedupe key so old reminders become no-ops. Cut-off windows are evaluated in the location zone and enforced server-side; staff can override with an audited reason. Cancel sets status, which releases the range because the constraint only covers active statuses.

**Slot holds (deferred).** `slot_holds` exists in the schema but is unused. If measured 409 rates on AI chat exceed 2% of attempts, holds become short-lived rows (5 min TTL) included in the same exclusion constraint, released by a sweeper and by commit.

## 7. Customer identity and merges

The system never decides two people are the same person; it only proposes, and a staff member decides, which is the direct answer to the Fresha complaint about overwritten family profiles.

**Matching on a public booking.** Normalise email (lowercase, trim) and phone (E.164 via libphonenumber, default region GB). Look for customers in the tenant with the same normalised email or phone.

| Match result | Behaviour |
| --- | --- |
| None | Create a new customer with `first_seen_source` = this booking's source |
| Exactly one, and the name matches (case and accent insensitive) | Attach the booking to that customer; never update their stored name or contact fields from public input |
| One or more, name differs | Create a new customer and raise a `possible_duplicate` suggestion in the back office |
| Verified customer (magic link or email code in this session) | Attach to the verified customer |

Public input never overwrites an existing customer's fields. Changes a customer makes to their own details go through a verified link.

**Merge.** A staff action with `customers.merge` permission, in one transaction: write `customer_merges` with a JSON snapshot of the source customer and the list of every row re-pointed (appointments, consents, custom field values, conversations); re-point those rows; set `source.merged_into_id` and soft-delete it. Consent after merge is the most restrictive of the two per channel and purpose, never the most permissive.

**Unmerge (within 30 days).** Restore the source customer from the snapshot and re-point exactly the rows listed in the merge record. Rows created after the merge stay with the surviving customer, and the UI says so before the user confirms. After 30 days a job drops the snapshot to meet data minimisation.

**Shared contacts in messaging.** Messages are addressed to a customer, not to an email address. Two customers sharing an inbox each get their own reminders, and the dedupe key includes `customer_id`, so they never suppress each other.

## 8. Jobs, messaging and rebooking

All asynchronous work runs on graphile-worker in a dedicated worker process, enqueued in the same database transaction as the state change, and every send re-checks eligibility at execution time, so a cancelled booking or a withdrawn consent can never be overtaken by a queued email.

**Why graphile-worker.** Its `graphile_worker.add_job()` is a SQL function, so enqueueing joins the caller's transaction with no separate outbox relay, and `job_key` gives replace-or-dedupe semantics for reminders. pg-boss is an acceptable alternative; hosted queues (Inngest, Trigger.dev) add a vendor and a network hop to the most correctness-critical path.

**Job catalogue.**

| Job | Trigger | Key | Retries |
| --- | --- | --- | --- |
| `send_confirmation` | Appointment created | `confirm:{appointment_id}` | 8, exponential to 1 h |
| `send_reminder` | Scheduled at `starts_at - offset` | `remind:{appointment_id}:{rule_id}:{starts_at}` | 8 |
| `rebooking_scan` | Cron, hourly; acts per tenant at 10:00 local | `scan:{tenant_id}:{local_date}` | 3 |
| `send_rebooking` | Enqueued by scan per eligible customer | `rebook:{customer_id}:{service_id}:{campaign_id}` | 8 |
| `import_dry_run`, `import_commit` | Owner action | `import:{import_id}:{phase}` | Resumable, checkpointed |
| `export_generate` | Owner action | `export:{export_id}` | 3 |
| `provider_webhook` | Resend webhook, Svix-verified | Provider event id | 5 |
| `retention_sweep` | Cron, daily | `retention:{date}` | 3 |

**Send pipeline (every outbound message).**

1. Load fresh state under `withTenant`. Abort with a recorded reason if the appointment is no longer in the right status, the start time moved (key mismatch), the tenant flag is off, or the template is unpublished.
2. Evaluate `canContact(customer, channel, purpose)`: transactional messages need a valid address and no hard bounce; marketing (rebooking) needs consent or a documented soft opt-in basis, no unsubscribe, no suppression, and the frequency cap (default one rebooking email per customer per 14 days).
3. Insert `message_sends` with the dedupe key. On conflict, an existing row already marked sent (or later) means exit successfully; a row still queued means an earlier attempt crashed, so continue to step 4.
4. Call the provider with the same dedupe key as its idempotency key. Record provider id and status; webhooks later move it to delivered, bounced or complained.

A crash between steps 3 and 4 leaves a `queued` row; the retry sees it and resends with the same provider idempotency key, so the provider deduplicates. Exhausted retries set `failed` and surface in the tenant's message log and the platform admin console.

**Communication provider interface.** `MessageChannel { kind: 'email' | 'sms'; send(msg, idempotencyKey) }`. Templates are rendered per channel; consent is stored per (customer, channel, purpose). Adding SMS means a new adapter and templates, no domain change. The dev adapter writes to `message_sends` with `provider = 'dev'` and logs, and the UI labels those sends as simulated.

**Rebooking due list.** A single SQL view, `rebooking_candidates`, computes for each customer and service their last completed appointment, `due_at = last_completed + service.rebook_interval`, and whether a future appointment already exists. The back office lists rows with `due_at` in the chosen window and calls the same `canContact` used by the sender, showing the reason when suppressed (no consent, opted out, contacted 6 days ago, already booked). One function, two callers, so the list and the sender can never disagree.

**One-click rebook link.** The email carries a signed token referencing `campaign_send_id`, prefilled with last service and staff. Booking through it records `source = rebooking_email` and the campaign send. Attribution window: 14 days from send, shown in the UI.

## 9. AI assistant

The model can read tenant-configured data and propose actions, but it cannot commit anything: every mutation becomes a proposal card that the customer confirms with a click, and that click calls the same `BookingService` the booking page uses.

**Runtime.** A server-side tool loop (Anthropic Messages API behind an `LlmProvider` interface, max 6 tool calls per turn, 20 s budget), streamed to the widget over SSE. A deterministic `ScriptedLlmProvider` replays fixtures in tests. Conversations and messages are stored per tenant; PII is redacted from logs, not from the stored transcript the business owns.

**Tool contract.** Every tool is a Zod schema plus a handler that receives a server-built `ToolContext { tenantId, locationId, conversationId, verifiedCustomerId? }`. The model's arguments can never set tenant, customer identity or source.

| Tool | Kind | Guard |
| --- | --- | --- |
| `get_business_information` | Read | Returns only configured fields; missing field returns `unknown` |
| `list_services`, `get_service_details` | Read | Published services only |
| `check_availability` | Read | Same `computeSlots`; max 14-day range |
| `get_customer_appointments` | Read | Requires `verifiedCustomerId` (email one-time code); otherwise returns `verification_required` |
| `create_booking` | Proposal | Creates a `pending_action` row (60 min TTL), returns a card; no appointment written |
| `request_reschedule`, `request_cancellation` | Proposal | Requires verified customer; cut-off rules evaluated in the proposal and again at confirm |
| `create_human_handover` | Write | Creates `handover_requests` with transcript; returns the tenant's stated response time |

**Confirm flow.** The widget renders the proposal card from server data (not from model text). The customer clicks Confirm, which posts `pending_action_id` with an idempotency key to the normal booking endpoint, with `source = ai_chat`. The service re-validates availability, rules and the TTL, then commits or returns 409 with alternatives that the assistant then offers.

**Prompt-injection posture.** Inputs from customers and from tenant free-text (policies, intro copy) are treated as data, wrapped and labelled in the prompt. Because the model has no write tool that commits and no tool that reaches beyond the conversation's tenant, a successful injection can at worst produce a wrong proposal that a human must click, or a misleading sentence. The system prompt forbids stating prices, hours or policies not returned by a tool; an output check flags any currency amount or time in the reply that did not appear in a tool result this turn and replaces the turn with a handover offer.

**Degradation.** If the provider errors or times out, the widget switches to the plain booking flow with a one-line message. A per-tenant monthly token budget and a per-conversation cap (40 turns) bound cost; both are visible to the owner. AI chat is behind the `ai_chat` flag, default off.

**Evaluation.** A fixed suite of 150 scripted conversations (booking, rescheduling, unknown policy questions, injection attempts, Welsh and Polish phrasing) runs on every prompt or model change; release requires zero hallucinated prices or slots and handover on every unknown-policy case.

## 10. Attribution, analytics, import/export and widget

These four modules share one rule: the server records facts at the moment they happen, and everything the owner sees is a query over those facts with its rule printed next to the number.

**Attribution.** `source` is decided by the entry point, never the client: the booking page route sets `booking_page`, the widget iframe route sets `widget`, the confirm endpoint for an AI proposal sets `ai_chat`, a valid rebook token sets `rebooking_email`, staff routes set `staff`, the import job sets `import`. UTM and referrer are captured on first page load into a signed, 30-minute session cookie and copied onto the appointment. No billing, limit or entitlement code may import the attribution module; a lint rule enforces it.

**Analytics.** Computed by SQL over `appointments`, `appointment_events` and `message_sends`, refreshed into per-tenant daily rollups by a nightly job, with today computed live. Every attributed metric carries its rule as data (`{ rule: 'Booked via a rebooking email link within 14 days of send' }`) so the UI and `docs/attribution.md` render from one source. Rebooking conversion is shown as a rate with its denominator ("12 of 80 contacted rebooked") and no causal language.

**Import.**

1. Upload CSV (max 20 MB, 50k rows) to a private Supabase Storage bucket under the tenant prefix.
2. Pick a preset (Fresha, Treatwell, Square, generic) or map columns; the mapping is saved on `imports`.
3. `import_dry_run` streams the file, validates each row with Zod, normalises contacts, detects duplicates within the file and against existing customers, checks future appointments against the exclusion constraint in a rolled-back transaction, and writes `import_rows` with status and messages. Nothing visible changes.
4. Owner reviews counts and row errors, chooses how to treat duplicates (skip, create separate, link to existing), and optionally attests to existing marketing consent for the batch. Without attestation every imported customer is transactional-only.
5. `import_commit` processes rows in chunks of 500, each chunk one transaction, checkpointing `import_rows.status`. Re-running skips committed rows, so it is resumable and idempotent. All created rows carry `import_batch_id` and `source = import`.
6. Rollback (within 7 days) deletes the batch's rows unless any has a dependent change after commit: an appointment edited or completed, or a customer with a non-imported appointment. Those rows are listed and kept; the rest roll back.

**Export.** `export_generate` writes CSV and JSON per entity to storage, neutralising formula injection (cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with a quote). Download goes through an authenticated route that checks membership, audits, and redirects to a signed URL valid for 5 minutes. After cancellation the tenant enters `read_only` for 30 days with export available, then the deletion workflow runs.

**Widget.** A 4 KB loader script injects an iframe pointing at `book.rebook.ai/{slug}/embed`. The embed response sets `Content-Security-Policy: frame-ancestors` from `widget_allowed_origins`, which the browser enforces; the Origin header check on API calls is a second layer. Height sync uses `postMessage` with origin verification. Cookies inside the iframe are not relied on (third-party cookie blocking), so booking state lives in the iframe's memory and the idempotency key travels with the request. Public endpoints are rate-limited per IP and per tenant (availability 60/min/IP; booking 10/min/IP) using a Postgres fixed-window table in MVP.

**Branding.** `tenant_branding` holds a draft and a published version; preview renders the draft with a signed preview token; publish copies draft to published and is audited. Fonts come from a vetted list served from our own origin.

## 11. Reliability and operations

Production runs in three UK-hosted pieces (web, worker, database) with point-in-time recovery, and the worker is a first-class deployable because Vercel functions cannot host a long-running queue consumer.

**Deployment topology.**

| Component | Host (London region) | Scaling | Failure behaviour |
| --- | --- | --- | --- |
| Next.js web and API | Vercel, `lhr1` functions | Automatic | Stateless; retried by clients with idempotency keys |
| Worker | Fly.io or Railway, 2 instances | Manual, by queue lag | Jobs re-locked after 4 h timeout; at-least-once with idempotent handlers |
| Postgres, Auth, Storage | Supabase, `eu-west-2` | Vertical, Pro plan | PITR 7 days; nightly logical backup to a second provider |
| Email | Resend, EU region where available | Provider | Retries with idempotency keys; webhooks reconcile status |
| LLM | Anthropic API | Provider | Widget falls back to booking flow |

The web tier connects through Supavisor in transaction mode; `SET LOCAL` is transaction-scoped, so tenant context is safe under pooling. The worker uses a direct connection for `LISTEN/NOTIFY`.

**Environments.** Local (Supabase CLI, dev adapters), preview per PR (branch database from migrations plus seed), staging (real providers in test mode), production. Migrations run once per deploy from CI as `rebook_owner`, expand-then-contract for any breaking change.

**Observability.** OpenTelemetry traces and structured JSON logs carry `request_id`, `tenant_id`, `actor_kind` and never names, emails or phone numbers. Sentry for errors. Dashboards and alerts:

- SLO burn rate on booking page availability and commit latency (page at 2% budget in 1 h).
- Exclusion constraint violations per hour: expected non-zero under contention, alert on sudden spikes that indicate a broken availability read.
- Queue lag over 5 min, and any job in `failed`.
- Email bounce and complaint rate per tenant (above 0.3% complaints pauses that tenant's marketing sends).
- LLM error rate, latency, and spend per tenant.

**Abuse and security controls.** Rate limits on public routes; Cloudflare Turnstile on the booking form after 3 attempts from one IP; secrets only in platform secret stores; dependency and container scanning in CI; webhook signatures verified before parsing; CSP and HSTS on all origins; audit logs append-only (no UPDATE or DELETE grant for runtime roles).

**Data lifecycle.** Retention sweeps delete conversation transcripts after a tenant-configurable period (default 12 months), cancelled-tenant data after the 30-day grace period, and merge snapshots after 30 days. Deletion requests from a customer are executed per tenant and logged without the deleted content.

**Runbooks (written in Stage 7).** Double-booking report, cross-tenant access report, email provider outage, LLM outage, stuck import, restore from PITR.

## 12. Alternatives and spec decisions

The spec's stack holds up; the changes below are where it is silent or where following it literally would create a defect, and each needs owner sign-off before Stage 2.

**Alternatives considered.**

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Tenant isolation | Shared schema + RLS + composite FKs | Schema per tenant; database per tenant | Thousands of small tenants; per-tenant schemas multiply migration time and connection count for no isolation gain RLS cannot give |
| Double-booking prevention | Exclusion constraint, READ COMMITTED | SERIALIZABLE; advisory locks per staff; app-level check | Constraint is declarative, covers every write path including import and staff overrides, and fails fast with a typed error |
| Availability | Compute on read | Precomputed slot table | Load is tiny; precomputed slots go stale on every rule edit and add a sync problem |
| Queue | graphile-worker | pg-boss; Inngest; Redis/BullMQ | Transactional enqueue via SQL; no extra infrastructure |
| Customer auth | Hashed tokens and email codes | Supabase Auth accounts for customers | Lower friction, smaller account-takeover surface |
| AI mutations | Proposal + human click | Model calls commit tool after verbal "yes" | Removes the model from the trust path for writes |
| Rate limiting | Postgres fixed window | Upstash Redis | No new dependency at MVP load; swap behind an interface later |

**Spec changes and clarifications.**

1. **RLS must be real.** Spec 3.3 requires RLS, but Drizzle over a privileged connection bypasses it. Decision: runtime roles without `BYPASSRLS` and `withTenant` transaction context (section 4). Cost: every query is in a transaction; negligible at this load.
2. **Customer reads in AI chat require verification.** Spec F lists `get_customer_appointments` without saying how the customer is identified. An email address typed into chat is not identity. Decision: one-time email code before any customer-specific read or proposal.
3. **AI commits through a click, not a model tool.** Spec F says "explicit customer confirmation". Decision: confirmation is a UI action on a server-rendered card.
4. **The worker needs a home.** The spec names a durable queue but no host for its consumer. Decision: a separate worker deployment (section 11).
5. **Unmerge semantics.** "Reversible within 30 days" is defined as restoring re-pointed rows only; rows created after the merge stay (section 7).
6. **Import rollback dependencies.** "No later changes depend on it" is defined as listed in section 10, step 6, with partial rollback rather than all-or-nothing.
7. **Location time zone is authoritative.** The spec stores zone on tenant and location; availability, cut-offs and reminders use the location's.
8. **Customer role means tokens, not accounts** (section 4).
9. **Buffers block staff time.** `blocked` includes buffers, so one appointment's cleanup cannot overlap the next one's preparation.
10. **Price snapshot on appointments.** Not in the spec; required for stable attributed revenue.

**Codebase shape.** Single Next.js app with domain code in `src/modules/<module>/{domain,application,infrastructure}` and no framework imports in `domain`. Route handlers and server actions are thin adapters that parse with Zod and call application services. dependency-cruiser fails CI on cross-module imports that bypass a module's public `index.ts`, and on any UI import of domain internals.

## 13. Delivery plan and open questions

MVP launches Friday 11 December 2026: 32 working days from 29 October, assuming about four focused days a week with Claude Code, with the final week held as buffer. Each block ends on a gate that is an executed test; the midwife pilot goes live around 30 November and the event planner pilot around 4 December.

The detailed, gated execution order is in [`docs/phases.md`](./phases.md); it supersedes the block summary below where they differ.

1. **Thu 29 Oct – Sun 8 Nov, secure foundation.** Supabase, migrations, database roles, RLS, `withTenant`, composite FKs, sign-in, onboarding with business type and terminology, audit log, feature flags, isolation tests, CI. Gate: a demo event planner and a demo midwife exist and neither can reach the other's data.
2. **Mon 9 – Sun 15 Nov, timed booking engine and custom fields.** Services with `booking_mode` and location type, team members, hours and time off, `computeSlots` with DST tests, `BookingService` with exclusion constraint and idempotency, reschedule, cancel, complete and no-show, manage-booking links, custom field definitions and values. Gate: 50 parallel bookings for one slot yield exactly one.
3. **Mon 16 – Sun 22 Nov, email and the midwife flow.** Worker on Fly.io, send pipeline with neutral templates, confirmations and reminders, invite links, home visits with postcode areas and travel time, own-clients-only access, profile-view auditing, pause-all-messages. Gate: a midwife invites a client, the client books a home visit, both get correct emails, and no clinical field exists anywhere.
4. **Mon 23 – Sun 29 Nov, request-then-confirm and the planner flow.** Enquiry form, quotes with expiry, accept links, `daily_capacity`, deposit-received marking, balance-due reminder. Gate: two customers accepting the last date yield exactly one booking, and an expired quote releases the date. Midwife pilot live around 30 Nov, once legal documents are signed.
5. **Mon 30 Nov – Sun 6 Dec, back office polish and data.** Calendar day view, booking and enquiry detail, clients, settings, all at 375 px; CSV export; booking counts by source; opt-in anniversary nudge for planners. Gate: both businesses run a week from a phone. Event planner pilot live around 4 Dec.
6. **Mon 7 – Fri 11 Dec, hardening and launch.** Critical-journey E2E for both modes, production checks, runbooks, docs, pilot fixes. Gate: critical journey passes in production. **Launch Fri 11 Dec.**

**Cut from the earlier plan to make room:** the import UI (pilots get a scripted import; Fresha presets don't help these verticals), the embeddable widget, the analytics page beyond counts by source, and automated rebooking beyond the planners' opt-in nudge. **If we slip further, cut in this order:** the anniversary nudge, then source counts, then the shared unlisted midwife link. Isolation, overlap and capacity correctness, email, and the midwife privacy controls are never cut.

**After launch.** January: deposits through a connected-account processor (so a paid deposit confirms a planner booking automatically, funds settling to the planner), dated-order mode for bakers and makers, the import UI and widget, timed-mode pilots for salons, merge and unmerge, platform admin and support grants, billing. The AI chat assistant follows for non-health business types only.

**Spend.** Free tiers until about 20 November; from the pilot onwards roughly GBP 65 a month (Vercel Pro, Supabase Pro plus staging, Fly.io worker, Resend Pro), plus the GBP 52 ICO fee and a domain. About GBP 100 to 150 in total by launch.

**Open questions.**

- [ ] Legal: data processing agreement, DPIA and privacy policy for health business types, reviewed by a privacy lawyer by 25 Nov. Who drafts them?
- [ ] Midwife pilot: how many midwives, and do any work in a shared practice (decides the default for own-clients-only access)?
- [ ] Event planner pilot: named planner, and do they quote per event or sell fixed packages?
- [ ] Pricing: flat per business or tiered by team size (needed before billing in January).
- [ ] Production providers: confirm Resend and the sending domain strategy (shared domain vs each business's own domain with DKIM); sender name for midwives must be neutral.
- [ ] Public booking domain name (this doc uses `book.rebook.ai` as a placeholder).
- [ ] Worker host: Fly.io or Railway.
- [ ] Accept the decisions in section 12 and the launch-vertical plan in section 1?
- [ ] Non-technical deadlines: sending domain verified by 16 Nov; legal documents by 25 Nov; both pilots named with client lists by 23 Nov.
