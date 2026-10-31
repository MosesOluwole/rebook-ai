# ADR-004: Authentication, session verification and the authorised tenant context

- **Status:** Proposed (Phase 2). Becomes Accepted when Moses merges Phase 2.
- **Date:** 2026-10-30
- **Deciders:** Moses Oluwole (owner); drafted by Claude Code during Phase 2.
- **Source design:** `docs/architecture.md` §4 (tenancy, identity, authorisation);
  `docs/phases.md`, Phase 2; ADR-002 (roles and request context).

## Context

Phase 2 introduces the first signed-in users. The design fixes the shape: Supabase Auth issues
the session; the tenant comes from the URL slug checked against an active membership, never from
a header or body; RLS answers "which tenant" and a permission matrix answers "which action"; a
member of tenant A asking for tenant B's slug must get the same 404 as a slug that does not
exist. ADR-002 left two things open for this phase: how a signed-in user lists their tenants
before one is chosen (every policy needs a tenant id), and how a user's right to act in a tenant
is represented so that `withTenant` cannot be fed a context assembled from request data.

## Decisions

### 1. Supabase Auth through `@supabase/ssr`, server-side only

The app talks to Supabase Auth from the server alone: `createServerClient` from `@supabase/ssr`
(0.12.7, pinned) with the publishable key, sessions in HTTP-only cookies named `rebook-session`.
`src/shared/auth/supabase.ts` is the only place a Supabase client is created, and it exposes
only the Auth half (`Pick<SupabaseClient, 'auth'>`): the Data API is unreachable by
construction, matching ADR-002 §1. There is no browser client, so the browser never learns the
Supabase URL or any key, and `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` are ordinary server
variables, not `NEXT_PUBLIC_*`. The admin key and the JWT secret are never configured for this
app; `pnpm check:secrets` fails CI if a reference appears under `src/`.

The application sees Supabase only through the `AuthGateway` port
(`src/modules/tenancy/application/ports.ts`); the adapter lives in
`infrastructure/supabase-auth.ts`.

### 2. The user is verified on every request

Identity comes from `supabase.auth.getClaims()`, which verifies the access token's signature and
expiry (against the project's JWKS, or by asking the Auth server when the project signs with a
symmetric secret, as the local stack does). The cookie's session payload is never decoded and
trusted. The verification happens twice per request on purpose: `src/proxy.ts` (Next 16's
request interceptor, Node runtime) refreshes expiring sessions, persists the new cookies, and
short-circuits signed-out requests (redirect to `/sign-in?next=` for `/app`, `/onboarding` and
`/invite`; 401 JSON under `/api`); every page, server action and route handler then calls
`currentUser()` itself, so the proxy is a convenience, not the gate. Decisions that need the
email to be verified _now_ (invite acceptance) use `getUser()`, a fresh read from the server.

### 3. Email links carry a token hash and land on our own route

Magic links and sign-up confirmations point at `/auth/confirm?token_hash=…&type=…` (templates in
`supabase/templates/`, wired in `supabase/config.toml`). The route verifies the hash server-side
with `verifyOtp` and sets the session cookies. A link therefore works in any browser, not only the
one that requested it, and the same route serves the sign-up confirmation flow production will
enable (`enable_confirmations`). The hosted project must carry the same templates.

### 4. `withUserContext` and `UserTx`: a user who has not chosen a tenant

`withUserContext(actor, work)` opens a transaction as `rebook_app` with `app.actor_id` and
`app.actor_kind = 'user'` installed and `app.tenant_id` explicitly set to `''`. Every tenant
policy fails closed; only the actor branches match. Two policies have such a branch:
`tenant_memberships_select` (`user_id = actor`, now `and actor_kind = 'user'`, a Phase 1
follow-up) and the new `tenants_select_member` (a user sees the tenant rows of their active memberships, so the switcher can show names and slugs). The member branch applies only while `app.tenant_id` is empty: inside a tenant context a user sees the current tenant's row and no other, even for tenants they belong to. The handle is a branded `UserTx`, and
exactly one repository accepts it: `myMembershipsRepository` ("list my memberships", plus the
active-role lookup that `resolveTenantForUser` needs). A `UserTx` is not a `TenantTx`, so no
tenant repository can be called from it (compile-time test).

### 5. Slug resolution through a SECURITY DEFINER function

`rebook.resolve_tenant_slug(slug)` runs as the owner with an empty `search_path`, returns the
tenant id or null and nothing else, and is executable by `rebook_app` only (revoked from PUBLIC,
`anon`, `authenticated` and the Data API admin role; the login role cannot call it). It is the
one way to learn a tenant id before a tenant context exists; whether the caller may enter that
tenant is decided afterwards. Phase 5's public pages reuse it.

### 6. `AuthorisedTenantContext`: how a user enters a tenant

`withTenant` accepts `UnauthenticatedTenantContext` (a plain object, for `customer`,
`anonymous`, `worker` and `system` actors) or `AuthorisedTenantContext` (branded; `actorKind`
`'user'`). A user context assembled from a URL or a form does not type-check (`@ts-expect-error`
tests in `tests/unit/tenancy/tenant-tx-type.test.ts`). Only the module mints the branded type,
through three constructors that are not exported from `index.ts`:

- `resolveTenantForUser(slug, actor)`: resolves the slug and looks up the user's active
  membership inside one `UserTx`; returns the context with the membership `role`. An unknown
  slug and a non-member produce the identical `NotFoundError` (same class, same message, no
  fields) and run the same two queries.
- onboarding (`grant: 'registration'`): the tenant does not exist yet; the context carries the
  app-generated id for the one transaction that inserts tenant, default location and owner
  membership. Slug collisions (`tenants_slug_unique`) abort that transaction and the whole
  attempt is retried with a suffixed slug and a fresh id, so nothing partial is committed.
- invite acceptance (`grant: 'invitation'`): the membership does not exist yet; the context
  admits the one transaction that checks the token and creates it.

`TenantTx` now carries the original `context`, so application commands read the role from it.

### 7. Permissions in the application layer

`can(role, permission)` (`domain/permissions.ts`) is checked by `assertPermission(tx, …)` at the
top of every command. `owner` holds everything; `staff` holds `workspace.view` only. Registration
and invitation grants, and non-user actors, hold no permission (`role: 'none'` in the typed
`PermissionDeniedError`). Owner-only in Phase 2: `members.invite`, `members.revoke`,
`flags.update`, `settings.update`; a test enumerates `OWNER_ONLY_PERMISSIONS` and fails if a
permission has no command under test.

### 8. Invitations are ours, with hashed tokens

`rebook.tenant_invitations` holds email (lower-cased), role, the SHA-256 of a 256-bit token,
expiry (7 days), accepted/revoked timestamps and the inviter. One open invitation per address per tenant: `createInvitation` refuses a duplicate (`DuplicateInvitationError`) and the partial unique index `tenant_invitations_open_email_unique` on `(tenant_id, lower(email))` settles the race between two owners. An expired invitation that nobody revoked is closed and replaced when the address is invited again. A user who is already an active member cannot accept another invitation (`AlreadyMemberError`); the role never changes through an invitation. The token appears once, in the
link the owner copies from the Team page (no email is sent until Phase 6); the invite form is the
phase's one client component so the link reaches the owner's browser without a redirect that
would put the secret in a URL. Acceptance requires a signed-in user whose verified email matches,
happens on a button rather than on the GET (mail scanners follow links), is idempotent, and every
failure mode (unknown slug, wrong or malformed token, expired, revoked, used, wrong address) is the
same `NotFoundError`; only the addressee can be told to verify their email.

### 9. Rate limits: a Postgres fixed window, keyed on client IP and on email

Sign-in, sign-up, the magic link and invite acceptance are rate limited before any credential is
checked (`docs/architecture.md` §10 and §12: a Postgres fixed-window table at MVP load, behind an
interface so Redis can replace it later). `rebook.rate_limits (key, window_start, window_seconds, count)` is the counter table and `rebook.rate_limit_hit(key, window_seconds, max_hits, at)` bumps and judges in
one statement; the clock is a parameter so the application passes its own and tests move windows. Each row records its own window length, and the occasional sweep removes only rows whose window ended more than its own length ago, so a ten-minute scope can never erase an hour-long counter. The table is platform-level: it has no `tenant_id` (sign-in happens before any tenant
exists) and is allow-listed by `pnpm db:check-schema`; it is reached through
`withAnonymousContext`, a third runner whose `AnonymousTx` (tenant and actor empty, kind
`anonymous`) is accepted by nothing else. Keys are SHA-256 hashes of `scope:kind:value`: the table holds pseudonyms, not addresses. The hash is unsalted, so someone with read access to the table could confirm a guessed address or enumerate IPv4 space by dictionary; only `rebook_app` can read it and the database already holds the addresses themselves, so a keyed hash (HMAC with a server secret) is deferred until a reader other than the app exists.

Every scope is limited twice, per client IP and per normalised (trimmed, lower-cased) email, and
both counters are bumped on every attempt; either exceeded refuses the attempt with the same
generic 429 ("Too many attempts. Try again in a few minutes.", `Retry-After`), so a caller cannot
learn whether an address exists. The limits live in
`src/modules/platform/domain/rate-limit.ts` (`AUTH_RATE_LIMITS`): sign-in 20/IP and 5/address
per 10 minutes, sign-up 20/IP and 3/address per hour, magic link 10/IP and 3/address per 10
minutes, invite acceptance 30/IP and 10/address per 10 minutes.

The client IP comes from one request header named by `CLIENT_IP_HEADER`, which must be the header
the trusted reverse proxy in front of the app sets (locally `x-forwarded-for`, which nothing
untrusted can reach; on the hosting platform its guaranteed header, for example `x-real-ip`).
Only the first address of the header counts; a missing or malformed value lands in a shared
`unknown` bucket rather than escaping the limit. The variable is required so the app refuses to
start rather than guess.

To return a real 429, these four flows are route handlers (`/auth/password`, `/auth/magic-link`,
`/auth/sign-up`, `/invite/[slug]/[token]/accept`) rather than server actions. Route handlers are
not covered by React's server-action origin check, so each one verifies that the request's
`Origin` (or `Referer`) is this site before reading the form (403 otherwise). "This site" is the
origin the browser used: `x-forwarded-host` and `x-forwarded-proto` from the reverse proxy, or
the `Host` header when the app is reached directly. It is never `request.nextUrl`, which Next's
Node server builds from its listen address (`localhost` behind any proxy). For the same reason every redirect a route handler issues is path-relative (percent-encoded, never carrying a host), and the request interceptor's signed-out redirect, which Next requires to be absolute, is built from that same browser-side origin and marked uncacheable. Sign-out stays a server action.

Costs of the limits, stated plainly: a known address's password sign-in and magic link can be
locked out by anyone for the length of a window (5 and 3 attempts per 10 minutes); the owner's
recourse in the pilot is to wait, and support can clear the counters in `rebook.rate_limits`.
Before Phase 9, verify on the hosting platform that the proxy overwrites (not appends to) the
header named by `CLIENT_IP_HEADER` and forwards `x-forwarded-host`: send a request with a forged
header and confirm the app saw the proxy's value.

### 10. A health business stays a health business

`updateBusinessSettings` refuses a change from `midwife` to any non-health type
(`BusinessTypeChangeError`, typed, with a settings message) because the health rules that
protect a midwife's patients (neutral messaging, no marketing sends, no clinical fields) would
otherwise be lifted over existing clients. Non-health to midwife, and changes between non-health
types, are allowed and audited. The trigger `tenants_business_type_health_lock` enforces the
same rule in the database as the backstop. It stops the owner role too: a deliberate data correction needs the trigger disabled explicitly, in a migration, with the reason recorded.

## Alternatives considered

- **Supabase admin invites** (`inviteUserByEmail`): needs the admin key in the app. Rejected by
  the design.
- **A browser Supabase client with PKCE**: the standard SSR recipe, but it exposes the project
  URL and key to the browser and ties an email link to the browser that requested it. Rejected.
- **A SECURITY DEFINER function returning the user's tenants with names**: fewer policies, but a
  wider privileged read path than the one-id resolver. The `tenants_select_member` policy keeps
  the read under RLS instead. Rejected.
- **Accepting invitations on GET**: one click fewer; unsafe with link-prefetching mail clients.
  Rejected.
- **Rate limiting in the proxy**: one place for every route, but the proxy would have to parse
  multipart form bodies to key on the address, and it has no transaction. Rejected; the proxy
  stays a session refresher.
- **Server actions with a message instead of a 429**: simpler, but a server action cannot set the
  response status, and Moses asked for 429. Rejected in favour of route handlers with their own
  origin check.

## Consequences

- Positive: a forged or expired cookie is a signed-out request everywhere; `withTenant` cannot be
  handed a user context from request data; the Data API has no client in the app at all; slug
  misses and membership misses are indistinguishable; the invite secret is never stored or
  logged. Driver errors leaving a runner are redacted (`redactQueryParams`): Drizzle's bound
  parameters and Postgres's quoted values and key details never reach a log, while SQLSTATE and
  constraint names survive for error mapping; typed domain errors pass through untouched.
- Costs: two verification calls per request (proxy and page); a `<select>` for time zones and a
  copy-the-link step for invitations until Phase 6; `getClaims()` on the local stack is a
  network round trip because it signs with a shared secret; one more required variable (`CLIENT_IP_HEADER`) and one more transaction per sign-in attempt for the limiter.
- Revisit when: the hosted project moves to asymmetric signing keys (then `getClaims()` verifies
  locally), Phase 5 adds public pages (a third runner for `anonymous` actors around the same slug
  resolver), and Phase 6 sends invitation emails (the worker already holds SELECT on
  `tenant_invitations`).
