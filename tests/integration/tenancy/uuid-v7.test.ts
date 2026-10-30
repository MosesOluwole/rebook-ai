import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { locationsRepository } from '@/modules/tenancy';
import { isUuidV7, uuidV7Timestamp } from '@/shared/kernel/uuid-v7';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import { contextFor, seedTenantPair, type TenantPair } from '../../helpers/tenant-fixtures';

/** rebook.uuid_generate_v7(): valid version-7 ids that sort in creation order (tested in SQL). */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'uuid');
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

describe('rebook.uuid_generate_v7()', () => {
  it('returns version 7 with the RFC variant and the current time in its first 48 bits', async () => {
    const [row] = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ id: string; now_ms: string }>(
        sql`select rebook.uuid_generate_v7()::text as id, (extract(epoch from clock_timestamp()) * 1000)::bigint::text as now_ms`,
      ),
    );
    if (row === undefined) {
      throw new Error('no row');
    }
    expect(isUuidV7(row.id)).toBe(true);
    expect(Math.abs(uuidV7Timestamp(row.id) - Number(row.now_ms))).toBeLessThan(5_000);
  });

  it('produces 2000 distinct ids in one statement that sort in creation order', async () => {
    const [row] = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      tx.db.execute<{ distinct_count: number; in_creation_order: boolean; all_v7: boolean }>(sql`
        with generated as (
          select n, rebook.uuid_generate_v7() as id from generate_series(1, 2000) as n
        )
        select
          count(distinct id)::int as distinct_count,
          (array_agg(id order by n) = array_agg(id order by id)) as in_creation_order,
          bool_and(substring(id::text from 15 for 1) = '7' and substring(id::text from 20 for 1) in ('8', '9', 'a', 'b')) as all_v7
        from generated
      `),
    );
    expect(row).toEqual({ distinct_count: 2000, in_creation_order: true, all_v7: true });
  });

  it('sorts ids generated across separate statements in creation order too', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const [row] = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        tx.db.execute<{ id: string }>(sql`select rebook.uuid_generate_v7()::text as id`),
      );
      if (row !== undefined) {
        ids.push(row.id);
      }
    }
    expect(ids).toHaveLength(20);
    expect([...ids].sort()).toEqual(ids);
  });

  it('is the default primary key of the tables', async () => {
    const location = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
      locationsRepository.insert(tx, { name: 'Default id probe', timeZone: 'Europe/London' }),
    );
    expect(isUuidV7(location.id)).toBe(true);
    expect(Math.abs(uuidV7Timestamp(location.id) - Date.now())).toBeLessThan(10_000);
  });
});
