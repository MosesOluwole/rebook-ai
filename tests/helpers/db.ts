import { getEnv } from '@/shared/config/env';
import { createDbClient, type DbClient } from '@/shared/db/client';

import { loadProjectEnv } from './load-env';

/**
 * Connects to the local test database (the Supabase stack from `pnpm db:start`) and proves it
 * answers before handing the client to a test. Fails with an actionable message otherwise.
 * Phase 1 extends this with per-role connections (rebook_app, rebook_worker) for isolation tests.
 */
export async function connectTestDb(): Promise<DbClient> {
  loadProjectEnv();
  const url = getEnv().DATABASE_URL;
  const client = createDbClient(url, { max: 2, applicationName: 'rebook-ai-tests' });
  try {
    await client.sql`select 1`;
  } catch (error) {
    await client.close();
    throw new Error(describeUnreachable(url, error), { cause: error });
  }
  return client;
}

function describeUnreachable(url: string, error: unknown): string {
  // Never echo the URL itself: it carries credentials.
  const { hostname, port } = new URL(url);
  const where = port === '' ? hostname : `${hostname}:${port}`;
  const cause = error instanceof Error ? error.message : String(error);
  return (
    `Test database not reachable at ${where}. ` +
    'Start the local stack with `pnpm db:start` or fix DATABASE_URL in .env. ' +
    `Cause: ${cause}`
  );
}
