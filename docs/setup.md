# Local setup

Everything a fresh clone needs to run Rebook AI, its tests and its database. If a step is missing
here, that is a bug in this document.

## Prerequisites

| Tool                              | Version                  | Notes                                                                 |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Node.js                           | 24.22.x (`.nvmrc`)       | `nvm install` in the repo picks it up. Any Node 24.22+ works.         |
| pnpm                              | 11.28.x (`package.json`) | `corepack enable` once; pnpm then matches `packageManager` by itself. |
| Docker Desktop (or Docker Engine) | current                  | Runs the local Supabase stack. Allow at least 4 GB memory.            |

The Supabase CLI is **not** installed globally: it is a pinned devDependency, so `pnpm exec supabase`
(or the `pnpm db:*` scripts) always runs the version this repo was tested with.

## First run

```sh
git clone <repo> rebook-ai && cd rebook-ai
nvm install                 # installs/uses the Node version in .nvmrc
corepack enable             # makes the pinned pnpm available
pnpm install                # fails fast if Node or pnpm are outside package.json "engines"
cp .env.example .env        # local defaults; the app refuses to start without a valid .env
pnpm db:start               # supabase start (pulls images the first time), then pnpm db:roles
pnpm dev                    # http://localhost:3000  and  http://localhost:3000/health
```

`pnpm db:start` runs `supabase start`, which applies every migration to a fresh database, and
then `pnpm db:roles`, which sets the local password of the `rebook_authenticator` role to the one
in `APP_DATABASE_URL` and verifies the login. Migrations never contain passwords; in production
the platform secret store plays this role. Run `pnpm db:roles` again if you ever see
"password authentication failed for user rebook_authenticator".

Sign up at http://localhost:3000/sign-up, then create your business. Every email the local stack
sends (sign-in links, confirmations) lands in Mailpit at http://127.0.0.1:54324; nothing leaves
your machine. Email confirmation is off locally (`[auth.email] enable_confirmations` in
`supabase/config.toml`); production turns it on, and the same `/auth/confirm` route handles it.

`/health` returns JSON like `{"status":"ok","service":"rebook-ai","version":"0.0.0",...}` with
`cache-control: no-store`.

For end-to-end tests, install the browser once:

```sh
pnpm exec playwright install chromium
```

## Everyday commands

| Command                   | Purpose                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`              | typecheck, lint, dependency rules, formatting, the secrets and migrations checks, unit tests                                        |
| `pnpm check:secrets`      | fail if anything under `src/` references the Supabase admin key, secret key or JWT secret                                           |
| `pnpm check:migrations`   | fail if a migration that exists on `origin/master` was modified, renamed or deleted (`--base <ref>` to compare with something else) |
| `pnpm test`               | unit tests (no database)                                                                                                            |
| `pnpm test:integration`   | integration tests against the local database (`pnpm db:start` first)                                                                |
| `pnpm test:e2e`           | the e2e gate: a fresh production build started on port 3100 by Playwright, desktop and 375 px                                       |
| `pnpm test:e2e:dev-smoke` | non-blocking smoke run against `pnpm dev` on port 3200 (health and home page only)                                                  |
| `pnpm db:status`          | URLs and keys of the local stack                                                                                                    |
| `pnpm db:migrate`         | apply pending migrations in `supabase/migrations`                                                                                   |
| `pnpm db:reset`           | drop and recreate the local database from migrations and `supabase/seed.sql`, then `pnpm db:roles`                                  |
| `pnpm db:roles`           | set the local `rebook_authenticator` password from `APP_DATABASE_URL` and verify login                                              |
| `pnpm db:check-schema`    | tenant-isolation check on every `rebook` table (also run in CI)                                                                     |
| `pnpm db:docs`            | regenerate the catalogue section of `docs/schema.md` (`--check` in CI)                                                              |
| `pnpm db:generate`        | write a new migration from the Drizzle schema (`--custom --name=x` for hand-written SQL)                                            |
| `pnpm db:stop`            | stop the local stack (data is kept)                                                                                                 |

## The local stack

`pnpm db:start` runs Supabase locally from `supabase/config.toml` (project id `rebook-ai`,
Postgres 17). Realtime, Edge Functions and Analytics are disabled because nothing uses them, and
`auto_expose_new_tables` is off so no table is reachable through the PostgREST Data API without an
explicit grant. The hosted Supabase project must carry the same settings: every read and write
goes through `withTenant` in the app, never through the Data API, and the auth email templates in
`supabase/templates/` (magic link and confirmation) point at the app's `/auth/confirm` route.
Changing `config.toml` or a template needs `pnpm db:stop && pnpm db:start` to take effect.

| Service          | URL                                                       |
| ---------------- | --------------------------------------------------------- |
| Postgres         | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| API gateway      | http://127.0.0.1:54321                                    |
| Studio           | http://127.0.0.1:54323                                    |
| Mailpit (emails) | http://127.0.0.1:54324                                    |

## Environment variables

Declared and validated in `src/shared/config/env.ts`. The server validates them at start-up
(`src/instrumentation.ts`) and exits with a message naming each problem; tests and Drizzle Kit
load `.env` the same way Next.js does.

| Variable                   | Required | Purpose                                                                                                                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_DATABASE_URL`         | yes      | Runtime connection as `rebook_authenticator`; `withTenant` switches to a runtime role per transaction                                                                    |
| `DATABASE_URL`             | tooling  | Owner connection (Supabase `postgres`) for migrations, Drizzle Kit, `pnpm db:roles` and test fixtures. The app never reads it; leave it unset in production              |
| `SUPABASE_URL`             | yes      | Supabase API gateway, used by the server only (`API_URL` in `pnpm db:status`)                                                                                            |
| `SUPABASE_PUBLISHABLE_KEY` | yes      | The project's publishable or anon key (`PUBLISHABLE_KEY` / `ANON_KEY` in `pnpm db:status`). Public by design; the browser still never receives it                        |
| `APP_ORIGIN`               | yes      | Public origin of the app (`http://localhost:3000` locally). The base of every outbound link and of the same-origin check on form posts; never taken from request headers |
| `NODE_ENV`                 | no       | Set by Next.js and Vitest                                                                                                                                                |

`APP_ORIGIN` must be exactly the origin users type (scheme, host, port; no path) and must equal
the Supabase project's Site URL, which Supabase's own emails link to. Form posts whose `Origin`
(or, without one, `Referer`) is not `APP_ORIGIN` are refused with 403; in development only,
`127.0.0.1` and `[::1]` on the same port are accepted too when `APP_ORIGIN` is a loopback address.
There is one `APP_ORIGIN` per deployment: a Vercel preview on its own unique URL refuses every form
post (403) and sends signed-out visitors to `APP_ORIGIN`, so give previews their own `APP_ORIGIN`
(a stable preview alias) before using them for sign-in. The e2e gate is the one deliberate
exception to "Site URL equals `APP_ORIGIN`": it runs on 3100 while the local Supabase Site URL is
3000, and `tests/e2e/helpers/mailpit.ts` rewrites email links to the gate's origin.

The client IP for rate limits is not configurable. Production trusts Vercel's
`x-vercel-forwarded-for`, the e2e gate (`NODE_ENV=test`) trusts the test header
`x-rebook-test-client-ip`, and development trusts no header (ADR-004 §9). Before deploying, send a
request with a forged `x-vercel-forwarded-for` through Vercel and confirm the app keyed on the
platform's value; in production a missing or malformed header is logged once and all such requests
share one rate-limit bucket. `CLIENT_IP_HEADER` and `NEXT_PUBLIC_APP_URL` from older `.env` files
are ignored.

The value of `SUPABASE_PUBLISHABLE_KEY` in `.env.example` and in CI is the Supabase CLI's fixed
local demo anon key, the one `pnpm db:status` prints on every machine; it is public by design and
is the one non-placeholder the example file carries. The admin (RLS-bypassing) key and the JWT
secret are never configured for this app, in any environment: `pnpm check:secrets` fails CI if a
reference appears under `src/`.

Example of the failure you get when `APP_DATABASE_URL` is missing or blank:

```
Invalid environment configuration (1 problem). The app will not start until this is fixed.
  - APP_DATABASE_URL: missing. Expected Postgres connection string for the app role rebook_authenticator, e.g. postgresql://rebook_authenticator:<password>@127.0.0.1:54322/postgres.
Copy .env.example to .env for local defaults; see docs/setup.md.
```

## Database roles and tenant context

The app connects as `rebook_authenticator`, a login role with no table privileges. Every query
runs inside `withTenant(ctx, work)` from `src/modules/tenancy`, which opens a transaction, runs
`SET LOCAL ROLE rebook_app`, installs the tenant context, and hands the work a `TenantTx` that
repositories require. Background jobs use `withWorkerTenant` and `rebook_worker`. Migrations run
as Supabase's `postgres` role and never at runtime. Details: `docs/adr/ADR-002-schema-roles-context.md`
and `docs/schema.md`.

A signed-in user reaches a tenant only through `resolveTenantForUser(slug, actor)`, which returns
the branded `AuthorisedTenantContext` that `withTenant` requires for user actors; before a tenant
is chosen, `withUserContext` lists the user's own memberships and nothing else. Identity comes
from Supabase Auth, verified server-side on every request (`src/proxy.ts` and the pages); see
`docs/adr/ADR-004-auth-sessions.md`.

The hosted Supabase project must match the local configuration before Phase 9: `rebook` absent
from the Data API schemas, `auto_expose_new_tables` off, the auth email templates from
`supabase/templates/`, email confirmation on, and the `rebook_authenticator` password set from
the platform secret store.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `master`:

1. **static**: install, `typecheck`, `lint`, `lint:deps`, `format:check`, `check:secrets`,
   `check:migrations` (pull requests compare with the target branch, pushes with the commit
   before the push; the checkout fetches full history for it), unit tests.
2. **integration**: starts the same Supabase Postgres image as local (`supabase db start`),
   applies all migrations to the empty database, re-applies them (must be a no-op), sets the
   `rebook_authenticator` password, runs the tenant-isolation schema check and the
   `docs/schema.md` freshness check, then `test:integration`.
3. **e2e**: starts the local Supabase stack with Auth and Mailpit (`supabase start -x …` without
   the services the app does not use), then `pnpm test:e2e`: Playwright builds the app fresh and
   starts it with `next start` on port 3100 (`NODE_ENV=test`, `APP_ORIGIN=http://localhost:3100`,
   never reusing a server). Then the dev-server smoke run (`pnpm test:e2e:dev-smoke`, port 3200),
   which is `continue-on-error` and never blocks the job. The HTML report is uploaded on failure.
4. **CI passed**: a single job that fails unless all three succeeded.

To make CI block merges, require the `CI passed` check on `master`. With the GitHub CLI (replace
`OWNER/REPO`):

```sh
gh api -X PUT repos/OWNER/REPO/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["CI passed"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Or in the web UI: Settings → Branches → Add branch protection rule for `master` → "Require status
checks to pass before merging" → select **CI passed**.

## Troubleshooting

- **`pnpm install` says the Node or pnpm version is incompatible.** `engineStrict` is on. Run
  `nvm install` (reads `.nvmrc`) and `corepack enable`, then retry.
- **`pnpm dev` exits with "Invalid environment configuration".** Create `.env` from
  `.env.example` or fix the variable it names. Blank values count as missing.
- **`pnpm db:start` fails.** Docker must be running. Ports 54321–54324 must be free
  (`lsof -nP -iTCP:54322 -sTCP:LISTEN`). First start downloads about 1 GB of images.
- **`pnpm db:reset` ends with a `HealthCheckTimeoutError` for `supabase_storage`.** The database
  was recreated and every migration applied before the Storage container (unused until Phase 8)
  missed its health check on a busy Docker host. Because the script chains `pnpm db:roles` after
  the reset, run `pnpm db:roles` by hand, then carry on.
- **Integration tests say "Database not reachable".** Run `pnpm db:start`; the error names the
  role, host and port it tried. If the cause is "password authentication failed", run
  `pnpm db:roles`.
- **`pnpm db:docs --check` fails in CI.** A migration changed the schema; run `pnpm db:docs`
  locally and commit `docs/schema.md`.
- **`pnpm db:check-schema` fails.** A new `rebook` table is missing `tenant_id`, forced RLS or a
  policy, has a foreign key that is not `tenant_id → tenants(id)` or composite on `tenant_id`, or
  something granted `anon`, `authenticated` or `service_role` a privilege. Fix the migration; never
  allow-list a tenant-owned table.
- **`pnpm test:e2e` cannot start the server.** Port 3100 is taken (the gate never reuses a
  running server, by design), `.env` is missing, or the build failed: the build output is in the
  Playwright log. The gate runs `NODE_ENV=production pnpm build`, then `NODE_ENV=test pnpm start
--port 3100` with `APP_ORIGIN=http://localhost:3100`; the production bundle is unchanged, only the
  runtime mode differs, which is what lets the app trust the test client-IP header. A running
  `pnpm dev` on port 3000 does not interfere. `pnpm test:e2e:dev-smoke` uses port 3200.
- **Sign-in link emails never arrive.** They go to Mailpit (http://127.0.0.1:54324), not to a real
  inbox. If the link points at the wrong route, the templates were not loaded: `pnpm db:stop &&
pnpm db:start`.
- **`pnpm check:migrations` says it cannot resolve the base ref.** Fetch the default branch
  (`git fetch origin master`) or pass `--base <ref>`. If it reports a modified migration, you
  edited a file that is already on `master`: revert it and add a new migration instead. In CI a
  push whose previous commit is unknown (branch creation, force push) makes the script skip with
  a notice; pull requests always run it against their base branch. This is safe only because the
  branch protection below forbids force pushes to `master` (`allow_force_pushes: false`).
- **`pnpm check:secrets` fails.** Something under `src/` mentions the Supabase admin key, secret
  key or JWT secret, even in a comment. The app never uses them; remove the reference.
- **Formatting or lint fails in CI only.** Run `pnpm format` and `pnpm lint` locally; CI treats
  warnings as errors.
- **Sign-in says "Too many attempts".** The fixed-window limiter (ADR-004 §9) refused the
  address or the client IP; wait for the window (minutes). In development every request shares
  one IP bucket (no header is trusted); the e2e gate sends `x-rebook-test-client-ip` per test. Counters live in `rebook.rate_limits`.
- **After upgrading Next.js, back-office pages 500 on a token refresh.** `src/app/_lib/session.ts`
  recognises Next's render-time cookie error by its message text ("Cookies can only be modified
  in a Server Action or Route Handler", Next 16.4.3). Check the wording in the new version and
  update the pattern.
