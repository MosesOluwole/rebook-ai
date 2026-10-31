import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalTimeZone, ICU_LEGACY_TO_IANA } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectOwnerDb } from '../../helpers/db';

/**
 * Phase 2 follow-up 4 (docs/adr/ADR-003): the stored form of every zone Intl supports, and the
 * modern name every ICU legacy id is mapped to, exists in Postgres's `pg_timezone_names`.
 * Catalogue check, so the owner connection is used; nothing here asserts tenant behaviour.
 */

let owner: DbClient;

beforeAll(async () => {
  owner = await connectOwnerDb();
});

afterAll(async () => {
  await owner.close();
});

async function missingFromCatalogue(names: readonly string[]): Promise<string[]> {
  const rows = await owner.sql<{ zone: string }[]>`
    select z as zone from unnest(${[...names]}::text[]) as z
    where not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = z)
  `;
  return rows.map((row) => row.zone);
}

describe('time zones stored by the rule exist in pg_timezone_names', () => {
  it('for every value Intl.supportedValuesOf("timeZone") produces', async () => {
    const supported = Intl.supportedValuesOf('timeZone');
    expect(supported.length).toBeGreaterThan(300);
    const stored = supported.map((zone) => canonicalTimeZone(zone));
    expect(stored.filter((zone) => zone === null)).toEqual([]);
    const unique = [...new Set(stored.filter((zone): zone is string => zone !== null))];
    expect(await missingFromCatalogue(unique)).toEqual([]);
  });

  it('for every modern name in ICU_LEGACY_TO_IANA, and the legacy keys are never the stored form', async () => {
    const modern = Object.values(ICU_LEGACY_TO_IANA);
    expect(modern.length).toBeGreaterThanOrEqual(23);
    expect(await missingFromCatalogue(modern)).toEqual([]);
    for (const [legacy, target] of Object.entries(ICU_LEGACY_TO_IANA)) {
      expect(canonicalTimeZone(legacy), legacy).toBe(target);
      expect(canonicalTimeZone(target), target).toBe(target);
    }
  });

  it('the five ids Moses named resolve to the modern names and pass the database CHECK', async () => {
    const cases = [
      ['Asia/Calcutta', 'Asia/Kolkata'],
      ['Europe/Kiev', 'Europe/Kyiv'],
      ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
      ['Asia/Rangoon', 'Asia/Yangon'],
      ['Asia/Katmandu', 'Asia/Kathmandu'],
    ] as const;
    for (const [legacy, modern] of cases) {
      expect(canonicalTimeZone(legacy)).toBe(modern);
      expect(canonicalTimeZone(modern)).toBe(modern);
    }
    const rows = await owner.sql<{ zone: string; ok: boolean }[]>`
      select z as zone, rebook.is_time_zone(z) as ok
      from unnest(${cases.map(([, modern]) => modern)}::text[]) as z
    `;
    expect(rows.every((row) => row.ok)).toBe(true);
  });
});
