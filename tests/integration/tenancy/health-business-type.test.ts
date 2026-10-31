import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUSINESS_TYPES, isHealthBusiness } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';

/**
 * Which business types are health businesses is stated twice: isHealthBusiness in the domain and
 * rebook.is_health_business_type(text) in the database, which every health trigger calls
 * (tenants_business_type_health_lock, tenants_business_type_custom_fields_lock,
 * custom_field_definitions_health_rules). This test fails if the two ever disagree.
 */

let owner: DbClient;
let app: AppDb;

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  app = await connectAppDb({ max: 1 });
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

async function sqlAnswers(): Promise<Record<string, boolean>> {
  // Through the runtime role: the triggers run as the caller, so rebook_app must be able to call it.
  const rows = await app.client.sql.begin(async (tx) => {
    await tx`set local role rebook_app`;
    return tx<{ type: string; health: boolean }[]>`
      select t as type, rebook.is_health_business_type(t) as health
      from unnest(${[...BUSINESS_TYPES]}::text[]) as t
    `;
  });
  return Object.fromEntries(rows.map((row) => [row.type, row.health]));
}

describe('rebook.is_health_business_type agrees with isHealthBusiness', () => {
  it('gives the same answer for every business type', async () => {
    expect(await sqlAnswers()).toEqual(
      Object.fromEntries(BUSINESS_TYPES.map((type) => [type, isHealthBusiness(type)])),
    );
  });

  it('covers exactly the types the tenants CHECK allows, and is false for anything else', async () => {
    const [check] = await owner.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
      where conname = 'tenants_business_type_valid'
    `;
    // Set equality: the CHECK allows exactly BUSINESS_TYPES, no more and no fewer.
    const allowed = [...(check?.definition ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(allowed)].sort()).toEqual([...BUSINESS_TYPES].sort());
    const [row] = await owner.sql<{ unknown: boolean; nil: boolean; cased: boolean }[]>`
      select rebook.is_health_business_type('salon') as unknown,
             rebook.is_health_business_type(null) as nil,
             rebook.is_health_business_type('Midwife') as cased
    `;
    expect(row).toEqual({ unknown: false, nil: false, cased: false });
    // The function names no type outside BUSINESS_TYPES.
    const [fn] = await owner.sql<{ body: string }[]>`
      select p.prosrc as body from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'rebook' and p.proname = 'is_health_business_type'
    `;
    const named = [...(fn?.body ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const type of named) {
      expect(BUSINESS_TYPES as readonly (string | undefined)[], type).toContain(type);
    }
  });

  it('is immutable, has an empty search_path, and only the runtime roles may execute it', async () => {
    const [fn] = await owner.sql<
      {
        volatility: string;
        config: string[] | null;
        app: boolean;
        worker: boolean;
        anon: boolean;
      }[]
    >`
      select p.provolatile as volatility, p.proconfig as config,
        has_function_privilege('rebook_app', p.oid, 'EXECUTE') as app,
        has_function_privilege('rebook_worker', p.oid, 'EXECUTE') as worker,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'rebook' and p.proname = 'is_health_business_type'
    `;
    expect(fn).toEqual({
      volatility: 'i',
      config: ['search_path=""'],
      app: true,
      worker: true,
      anon: false,
    });
  });

  it('is what every health trigger calls (no trigger names a business type itself)', async () => {
    const triggers = await owner.sql<{ name: string; body: string }[]>`
      select p.proname as name, p.prosrc as body
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'rebook' and p.proname in (
        'tenants_business_type_health_lock',
        'tenants_business_type_custom_fields_lock',
        'custom_field_definitions_health_rules'
      )
      order by p.proname
    `;
    expect(triggers.map((t) => t.name)).toEqual([
      'custom_field_definitions_health_rules',
      'tenants_business_type_custom_fields_lock',
      'tenants_business_type_health_lock',
    ]);
    for (const trigger of triggers) {
      expect(trigger.body, trigger.name).toContain('rebook.is_health_business_type(');
      for (const type of BUSINESS_TYPES) {
        expect(trigger.body, `${trigger.name} names '${type}'`).not.toContain(`'${type}'`);
      }
    }
  });
});
