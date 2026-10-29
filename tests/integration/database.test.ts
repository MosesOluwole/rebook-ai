import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { connectTestDb } from '../helpers/db';

const projectRoot = process.cwd();

function configuredPostgresMajor(): number {
  const config = readFileSync(path.join(projectRoot, 'supabase', 'config.toml'), 'utf8');
  const match = /^major_version\s*=\s*(\d+)/m.exec(config);
  if (!match?.[1]) {
    throw new Error('supabase/config.toml has no [db] major_version');
  }
  return Number(match[1]);
}

function migrationVersionsOnDisk(): string[] {
  let files: string[];
  try {
    files = readdirSync(path.join(projectRoot, 'supabase', 'migrations'));
  } catch {
    return [];
  }
  return files
    .map((file) => /^(\d{14})_.+\.sql$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort();
}

describe('local database (Supabase Postgres)', () => {
  let client: DbClient;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client.close();
  });

  it('answers a query through postgres.js', async () => {
    const [row] = await client.sql<{ one: number }[]>`select 1 as one`;
    expect(row?.one).toBe(1);
  });

  it('answers a query through drizzle', async () => {
    const rows = await client.db.execute<{ two: number }>(sql`select 2 as two`);
    expect(rows[0]?.two).toBe(2);
  });

  it('runs the Postgres major version pinned in supabase/config.toml', async () => {
    const [row] = await client.sql<{ server_version: string }[]>`show server_version`;
    const major = Number(row?.server_version.split('.')[0]);
    expect(major).toBe(configuredPostgresMajor());
  });

  it('offers the extensions the data model relies on', async () => {
    // btree_gist: exclusion constraint on bookings; pg_trgm: customer search; citext: emails.
    const rows = await client.sql<{ name: string }[]>`
      select name from pg_available_extensions where name in ('btree_gist', 'pg_trgm', 'citext')
    `;
    expect(rows.map((row) => row.name).sort()).toEqual(['btree_gist', 'citext', 'pg_trgm']);
  });

  it('has applied exactly the migrations that exist on disk', async () => {
    // The Supabase CLI creates its ledger table with the first migration it applies, so a
    // database with no migrations has no table, and the list on disk must be empty too.
    const [ledger] = await client.sql<{ exists: string | null }[]>`
      select to_regclass('supabase_migrations.schema_migrations') as exists
    `;
    const applied =
      ledger?.exists === null
        ? []
        : (
            await client.sql<{ version: string }[]>`
              select version from supabase_migrations.schema_migrations order by version
            `
          ).map((row) => row.version);
    expect(applied).toEqual(migrationVersionsOnDisk());
  });
});
