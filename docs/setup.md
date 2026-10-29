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
pnpm db:start               # supabase start: pulls images the first time (a few minutes)
pnpm dev                    # http://localhost:3000  and  http://localhost:3000/health
```

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
| `pnpm db:reset`         | drop and recreate the local database from migrations and `supabase/seed.sql`                                                                                                             |
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

| Variable              | Required | Purpose                                                       |
| --------------------- | -------- | ------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | Postgres connection string (`postgres://` or `postgresql://`) |
| `NEXT_PUBLIC_APP_URL` | no       | Public origin of the app; defaults to http://localhost:3000   |
| `NODE_ENV`            | no       | Set by Next.js and Vitest                                     |

Example of the failure you get when `DATABASE_URL` is missing or blank:

```
Invalid environment configuration (1 problem). The app will not start until this is fixed.
  - DATABASE_URL: missing. Expected Postgres connection string, e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres.
Copy .env.example to .env for local defaults; see docs/setup.md.
```

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

1. **static**: install, `typecheck`, `lint`, `lint:deps`, `format:check`, unit tests.
2. **integration**: starts the same Supabase Postgres image as local (`supabase db start`),
   applies all migrations to the empty database, re-applies them (must be a no-op), runs
   `test:integration`.
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
- **Integration tests say "Test database not reachable".** Run `pnpm db:start`; the error names
  the host and port it tried.
- **`pnpm test:e2e` cannot start the server.** Something else is on port 3000, or `.env` is
  missing. Playwright reuses a running `pnpm dev` locally.
- **Formatting or lint fails in CI only.** Run `pnpm format` and `pnpm lint` locally; CI treats
  warnings as errors.
