/**
 * Sets the local password of `rebook_authenticator` to the one in APP_DATABASE_URL and proves
 * the login works. The username may be the bare role or the pooler form
 * `rebook_authenticator.<project-ref>`; only the role part is compared (scripts/lib/authenticator-role.ts). Migrations create the role without a password (no secrets in migrations); this
 * script is the local counterpart of the platform secret store. Idempotent; safe to re-run.
 *
 *   pnpm db:roles
 */
import { getEnv, getOwnerDatabaseUrl } from '../src/shared/config/env';
import { createDbClient } from '../src/shared/db/client';
import { AUTHENTICATOR_ROLE as ROLE, parseAuthenticatorUsername } from './lib/authenticator-role';
import { loadProjectEnv } from './lib/load-env';

function fail(message: string): never {
  process.stderr.write(`db:roles: ${message}\n`);
  process.exit(1);
}

loadProjectEnv();

const appUrl = new URL(getEnv().APP_DATABASE_URL);
const username = parseAuthenticatorUsername(decodeURIComponent(appUrl.username));
const appPassword = decodeURIComponent(appUrl.password);
if (!username.ok) {
  fail(username.reason);
}
if (appPassword === '') {
  fail('APP_DATABASE_URL has no password; add one after the role name');
}

const owner = createDbClient(getOwnerDatabaseUrl(), {
  max: 1,
  applicationName: 'rebook-ai-db-roles',
});
try {
  const [role] = await owner.sql<{ exists: boolean }[]>`
    select exists (select 1 from pg_catalog.pg_roles where rolname = ${ROLE}::name) as exists
  `;
  if (role?.exists !== true) {
    fail(`role ${ROLE} does not exist yet; apply the migrations first (pnpm db:migrate)`);
  }
  // ALTER ROLE cannot take bind parameters; format() quotes the literal safely.
  const [statement] = await owner.sql<{ sql: string }[]>`
    select format('alter role %I with password %L', ${ROLE}::text, ${appPassword}::text) as sql
  `;
  if (statement === undefined) {
    fail('could not build the ALTER ROLE statement');
  }
  await owner.sql.unsafe(statement.sql);
} finally {
  await owner.close();
}

const app = createDbClient(getEnv().APP_DATABASE_URL, {
  max: 1,
  applicationName: 'rebook-ai-db-roles',
});
try {
  // A pooler strips the project ref before it reaches Postgres: the session user is the bare role.
  const [who] = await app.sql<{ user: string }[]>`select current_user as user`;
  if (who?.user !== ROLE) {
    fail(`connected as '${who?.user ?? 'unknown'}' instead of ${ROLE}`);
  }
} catch (error) {
  fail(`login as ${ROLE} failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await app.close();
}

process.stdout.write(`db:roles: password set for ${ROLE} and login verified\n`);
