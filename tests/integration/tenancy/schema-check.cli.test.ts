import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { connectOwnerDb } from '../../helpers/db';

/**
 * Phase 1 criterion: "Adding a test table without RLS, or with a grant to anon, makes the CI
 * schema check fail." schema-check.test.ts proves the library returns findings; this file proves
 * the command CI actually runs (`pnpm db:check-schema`, i.e. scripts/check-schema.ts) exits
 * non-zero and names the offending tables. The bad tables have to be visible to the child
 * process, so they are committed and dropped again in afterAll (and defensively in beforeAll).
 */

const UNPROTECTED = 'zz_ci_unprotected';
const EXPOSED = 'zz_ci_exposed';

let owner: DbClient;

function runCheckSchema() {
  return spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/check-schema.ts'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

async function dropProbes(): Promise<void> {
  await owner.sql`drop table if exists rebook.${owner.sql(UNPROTECTED)}`;
  await owner.sql`drop table if exists rebook.${owner.sql(EXPOSED)}`;
}

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  await dropProbes();
});

afterAll(async () => {
  await dropProbes();
  await owner.close();
});

describe('pnpm db:check-schema (the CI command)', () => {
  it('exits 1 and names a table that has no RLS and no tenant_id', async () => {
    await owner.sql`create table rebook.${owner.sql(UNPROTECTED)} (id uuid primary key)`;
    try {
      const result = runCheckSchema();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toMatch(/db:check-schema: \d+ problem\(s\) in schema rebook/);
      expect(result.stderr).toContain(`rebook.${UNPROTECTED}: has no tenant_id column`);
      expect(result.stderr).toContain(`rebook.${UNPROTECTED}: row level security is not enabled`);
      expect(result.stderr).toContain(`rebook.${UNPROTECTED}: row level security is not forced`);
      expect(result.stderr).toContain(`rebook.${UNPROTECTED}: has no row level security policy`);
    } finally {
      await dropProbes();
    }
  });

  it('exits 1 for a fully protected table that grants anon a privilege', async () => {
    await owner.sql`create table rebook.${owner.sql(EXPOSED)} (id uuid primary key, tenant_id uuid not null)`;
    await owner.sql`alter table rebook.${owner.sql(EXPOSED)} enable row level security`;
    await owner.sql`alter table rebook.${owner.sql(EXPOSED)} force row level security`;
    await owner.sql`create policy p on rebook.${owner.sql(EXPOSED)} for all to rebook_app using (true)`;
    await owner.sql`grant select on rebook.${owner.sql(EXPOSED)} to anon`;
    try {
      const result = runCheckSchema();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`rebook.${EXPOSED}: anon holds SELECT`);
      expect(result.stderr).not.toContain('authenticated holds');
    } finally {
      await dropProbes();
    }
  });

  it('exits 0 again once the probe tables are gone', () => {
    const result = runCheckSchema();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/db:check-schema: every rebook table/);
  });
});
