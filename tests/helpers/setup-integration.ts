import { beforeAll } from 'vitest';

import { connectTestDb } from './db';
import { loadProjectEnv } from './load-env';

loadProjectEnv();

// Make an unreachable database fail every integration file up front, with one clear message.
beforeAll(async () => {
  const db = await connectTestDb();
  await db.close();
});
