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

`/health` returns JSON like `{"status":"ok","service":"rebook-ai","version":"0.0.0",...}` with
`cache-control: no-store`.

For end-to-end tests, install the browser once:

```sh
pnpm exec playwright install chromium
```

## Everyday commands

| Command                 | Purpose                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`            | typecheck, lint, dependency rules, formatting, unit tests                                                                                                                                |
| `pnpm test`             | unit tests (no database)                                                                                                                                                                 |
| `pnpm test:integration` | integration tests against the local database (`pnpm db:start` first)                                                                                                                     |
| `pnpm test:e2e`         | Playwright at desktop and 375 px; starts `pnpm dev` if nothing is on 3000                                                                                                                |
| `pnpm db:status`        | URLs and keys of the local stack                                                                                                                                                         |
| `pnpm db:migrate`       | apply pending migrations in `supabase/migrations`                                                                                                                                        |
| `pnpm db:reset`         | drop and recreate the local database from migrations and `supabase/seed.sql`, then `pnpm db:roles`                                                                                       |
| `pnpm db:roles`         | set the local `rebook_authenticator` password from `APP_DATABASE_URL` and verify login                                                                                                   |
| `pnpm db:check-schema`  | tenant-isolation check on every `rebook` table (also run in CI)                                                                                                                          |
| `pnpm db:docs`          | regenerate the catalogue section of `docs/schema.md` (`--check` in CI)                                                                                                                   |
| `pnpm db:generate`      | write a new migration from the Drizzle schema (`--custom --name=x` for hand-written SQL). Until Phase 1 adds the first `infrastructure/schema.ts`, it stops with "No schema files found" |
| `pnpm db:stop`          | stop the local stack (data is kept)                                                                                                                                                      |

## The local stack

`pnpm db:start` runs Supabase locally from `supabase/config.toml` (project id `rebook-ai`,
Postgres 17). Realtime, Edge Functions and Analytics are disabled because nothing uses them, and
`auto_expose_new_tables` is off so no table is reachable through the PostgREST Data API without an
explicit grant. The hosted Supabase project must carry the same setting before Phase 1 ships: every
read and write goes through `withTenant` in the app, never through the Data API.

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

| Variable              | Required | Purpose                                                                                                                                                     |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DATABASE_URL`    | yes      | Runtime connection as `rebook_authenticator`; `withTenant` switches to a runtime role per transaction                                                       |
| `DATABASE_URL`        | tooling  | Owner connection (Supabase `postgres`) for migrations, Drizzle Kit, `pnpm db:roles` and test fixtures. The app never reads it; leave it unset in production |
| `NEXT_PUBLIC_APP_URL` | no       | Public origin of the app; defaults to http://localhost:3000                                                                                                 |
| `NODE_ENV`            | no       | Set by Next.js and Vitest                                                                                                                                   |

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

The hosted Supabase project must match the local configuration before Phase 9: `rebook` absent
from the Data API schemas, `auto_expose_new_tables` off, and the `rebook_authenticator` password
set from the platform secret store.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

1. **static**: install, `typecheck`, `lint`, `lint:deps`, `format:check`, unit tests.
2. **integration**: starts the same Supabase Postgres image as local (`supabase db start`),
   applies all migrations to the empty database, re-applies them (must be a no-op), sets the
   `rebook_authenticator` password, runs the tenant-isolation schema check and the
   `docs/schema.md` freshness check, then `test:integration`.
3. **e2e**: `next build`, then Playwright against `next start`; the HTML report is uploaded on failure.
4. **CI passed**: a single job that fails unless all three succeeded.

To make CI block merges, require the `CI passed` check on `main` once the repository exists on
GitHub. With the GitHub CLI (replace `OWNER/REPO`):

```sh
gh api -X PUT repos/OWNER/REPO/branches/main/protection \
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

Or in the web UI: Settings → Branches → Add branch protection rule for `main` → "Require status
checks to pass before merging" → select **CI passed**.

## Troubleshooting

- **`pnpm install` says the Node or pnpm version is incompatible.** `engineStrict` is on. Run
  `nvm install` (reads `.nvmrc`) and `corepack enable`, then retry.
- **`pnpm dev` exits with "Invalid environment configuration".** Create `.env` from
  `.env.example` or fix the variable it names. Blank values count as missing.
- **`pnpm db:start` fails.** Docker must be running. Ports 54321–54324 must be free
  (`lsof -nP -iTCP:54322 -sTCP:LISTEN`). First start downloads about 1 GB of images.
- **Integration tests say "Database not reachable".** Run `pnpm db:start`; the error names the
  role, host and port it tried. If the cause is "password authentication failed", run
  `pnpm db:roles`.
- **`pnpm db:docs --check` fails in CI.** A migration changed the schema; run `pnpm db:docs`
  locally and commit `docs/schema.md`.
- **`pnpm db:check-schema` fails.** A new `rebook` table is missing `tenant_id`, forced RLS or a
  policy, has a foreign key that is not `tenant_id → tenants(id)` or composite on `tenant_id`, or
  something granted `anon`, `authenticated` or `service_role` a privilege. Fix the migration; never
  allow-list a tenant-owned table.
- **`pnpm test:e2e` cannot start the server.** Something else is on port 3000, or `.env` is
  missing. Playwright reuses a running `pnpm dev` locally.
- **Formatting or lint fails in CI only.** Run `pnpm format` and `pnpm lint` locally; CI treats
  warnings as errors.
