import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { createTenancy, type Tenancy } from '@/modules/tenancy';
import { getEnv, getOwnerDatabaseUrl } from '@/shared/config/env';
import { createDbClient, type DbClient } from '@/shared/db/client';

import { loadProjectEnv } from './load-env';

/**
 * Two deliberately separate connections to the local Supabase Postgres (`pnpm db:start`).
 *
 * - connectOwnerDb(): DATABASE_URL, Supabase's `postgres` role. Bypasses RLS. For catalogue
 *   checks and for fixtures that seed two tenants; never for the behaviour under test.
 * - connectAppDb(): APP_DATABASE_URL, `rebook_authenticator`. No table privileges until
 *   `withTenant` switches to a runtime role. Every behaviour test goes through this one.
 *
 * Both fail with an actionable message when the stack is down or the role password is unset.
 */

export interface AppDb {
  readonly client: DbClient;
  readonly db: PostgresJsDatabase;
  readonly tenancy: Tenancy;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Pool size. Use 1 to prove behaviour on a single pooled connection. */
  readonly max?: number;
}

const testClock = { now: () => new Date() };

export async function connectOwnerDb(options: ConnectOptions = {}): Promise<DbClient> {
  loadProjectEnv();
  return connect(getOwnerDatabaseUrl(), 'rebook-ai-tests-owner', options, 'DATABASE_URL');
}

export async function connectAppDb(options: ConnectOptions = {}): Promise<AppDb> {
  loadProjectEnv();
  const client = await connect(
    getEnv().APP_DATABASE_URL,
    'rebook-ai-tests-app',
    options,
    'APP_DATABASE_URL',
  );
  return {
    client,
    db: client.db,
    tenancy: createTenancy(client.db, testClock),
    close: () => client.close(),
  };
}

async function connect(
  url: string,
  applicationName: string,
  options: ConnectOptions,
  variable: string,
): Promise<DbClient> {
  const client = createDbClient(url, { max: options.max ?? 2, applicationName });
  try {
    await client.sql`select 1`;
  } catch (error) {
    await client.close();
    throw new Error(describeUnreachable(url, variable, error), { cause: error });
  }
  return client;
}

function describeUnreachable(url: string, variable: string, error: unknown): string {
  // Never echo the URL itself: it carries credentials.
  const { hostname, port, username } = new URL(url);
  const where = port === '' ? hostname : `${hostname}:${port}`;
  const cause = error instanceof Error ? error.message : String(error);
  const hint = /password|authentication/i.test(cause)
    ? `Run \`pnpm db:roles\` so the password in ${variable} is set on the local role.`
    : `Start the local stack with \`pnpm db:start\` or fix ${variable} in .env.`;
  return `Database not reachable as '${username}' at ${where}. ${hint} Cause: ${cause}`;
}
