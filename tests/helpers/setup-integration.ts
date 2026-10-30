import { beforeAll } from 'vitest';

import { connectAppDb, connectOwnerDb } from './db';
import { loadProjectEnv } from './load-env';

loadProjectEnv();

// Fail every integration file up front, with one clear message, when the stack is down or the
// rebook_authenticator password has not been set (`pnpm db:roles`).
beforeAll(async () => {
  const owner = await connectOwnerDb({ max: 1 });
  try {
    // Self-heal: probe tables (zz_ prefix) left behind by an interrupted run would otherwise
    // fail the schema check and the catalogue-driven suites until dropped by hand.
    const leftovers = await owner.sql<{ tablename: string }[]>`
      select tablename from pg_catalog.pg_tables where schemaname = 'rebook' and tablename like 'zz\\_%'
    `;
    for (const { tablename } of leftovers) {
      await owner.sql`drop table if exists rebook.${owner.sql(tablename)} cascade`;
    }
  } finally {
    await owner.close();
  }
  const app = await connectAppDb({ max: 1 });
  await app.close();
});
