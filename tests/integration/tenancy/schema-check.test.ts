import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbClient } from '@/shared/db/client';

import { checkSchema, type SchemaFinding, type SqlHandle } from '../../../scripts/lib/schema-check';
import { connectOwnerDb } from '../../helpers/db';

/**
 * The CI schema check (`pnpm db:check-schema`) must pass on the real schema and fail for a table
 * without RLS or with a grant to anon (docs/phases.md Phase 1). The bad tables are created inside
 * a transaction that is rolled back, so the check runs on the same connection.
 */

let owner: DbClient;

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
});

afterAll(async () => {
  await owner.close();
});

class Rollback extends Error {}

async function findingsWith(setup: (tx: SqlHandle) => Promise<void>): Promise<SchemaFinding[]> {
  let findings: SchemaFinding[] = [];
  await owner.sql
    .begin(async (tx) => {
      await setup(tx);
      findings = await checkSchema(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) {
        throw error;
      }
    });
  return findings;
}

describe('schema check', () => {
  it('passes on the migrated schema', async () => {
    expect(await checkSchema(owner.sql)).toEqual([]);
  });

  it('fails for a table without RLS, without a policy, or without tenant_id', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`create table rebook.zz_unprotected (id uuid primary key)`;
    });
    const problems = findings.filter((f) => f.table === 'zz_unprotected').map((f) => f.problem);
    expect(problems).toEqual(
      expect.arrayContaining([
        'has no tenant_id column',
        'row level security is not enabled',
        'row level security is not forced',
        'has no row level security policy',
      ]),
    );
  });

  it('fails for a grant to anon or authenticated even when RLS is in place', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`create table rebook.zz_exposed (id uuid primary key, tenant_id uuid not null)`;
      await tx`alter table rebook.zz_exposed enable row level security`;
      await tx`alter table rebook.zz_exposed force row level security`;
      await tx`create policy p on rebook.zz_exposed for all to rebook_app using (true)`;
      await tx`grant select on rebook.zz_exposed to anon`;
      await tx`grant insert on rebook.zz_exposed to authenticated`;
    });
    const problems = findings.filter((f) => f.table === 'zz_exposed').map((f) => f.problem);
    expect(problems).toEqual(['anon holds SELECT', 'authenticated holds INSERT']);
  });

  it('fails for a foreign key into another tenant-owned table that is not composite', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`
        create table rebook.zz_single_fk (
          id uuid primary key default rebook.uuid_generate_v7(),
          tenant_id uuid not null references rebook.tenants (id),
          location_id uuid not null references rebook.locations (id)
        )
      `;
      await tx`alter table rebook.zz_single_fk enable row level security`;
      await tx`alter table rebook.zz_single_fk force row level security`;
      await tx`create policy p on rebook.zz_single_fk for all to rebook_app using (true)`;
    });
    const problems = findings.filter((f) => f.table === 'zz_single_fk').map((f) => f.problem);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /foreign key zz_single_fk_location_id_fkey to rebook\.locations \(location_id\) must be tenant_id → tenants\(id\), \(tenant_id, …\)/,
    );
  });

  it('accepts a single-column foreign key to auth.users(id), the one non-tenant parent', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`
        create table rebook.zz_user_fk (
          id uuid primary key default rebook.uuid_generate_v7(),
          tenant_id uuid not null references rebook.tenants (id),
          user_id uuid not null references auth.users (id) on delete cascade,
          unique (tenant_id, id)
        )
      `;
      await tx`alter table rebook.zz_user_fk enable row level security`;
      await tx`alter table rebook.zz_user_fk force row level security`;
      await tx`create policy p on rebook.zz_user_fk for all to rebook_app using (true)`;
    });
    expect(findings.filter((f) => f.table === 'zz_user_fk')).toEqual([]);
  });

  it('rejects a single-column foreign key to any other table outside rebook', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`
        create table rebook.zz_other_schema_fk (
          id uuid primary key default rebook.uuid_generate_v7(),
          tenant_id uuid not null references rebook.tenants (id),
          identity_id uuid references auth.identities (id)
        )
      `;
      await tx`alter table rebook.zz_other_schema_fk enable row level security`;
      await tx`alter table rebook.zz_other_schema_fk force row level security`;
      await tx`create policy p on rebook.zz_other_schema_fk for all to rebook_app using (true)`;
    });
    const problems = findings.filter((f) => f.table === 'zz_other_schema_fk').map((f) => f.problem);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/to auth\.identities \(identity_id\)/);
  });

  it('accepts the composite foreign key pattern', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`
        create table rebook.zz_composite_fk (
          id uuid primary key default rebook.uuid_generate_v7(),
          tenant_id uuid not null references rebook.tenants (id),
          location_id uuid not null,
          unique (tenant_id, id),
          foreign key (tenant_id, location_id) references rebook.locations (tenant_id, id)
        )
      `;
      await tx`alter table rebook.zz_composite_fk enable row level security`;
      await tx`alter table rebook.zz_composite_fk force row level security`;
      await tx`create policy p on rebook.zz_composite_fk for all to rebook_app using (true)`;
    });
    expect(findings.filter((f) => f.table === 'zz_composite_fk')).toEqual([]);
  });

  it('fails when the schema itself is granted to a Data API role', async () => {
    const findings = await findingsWith(async (tx) => {
      await tx`grant usage on schema rebook to anon`;
    });
    expect(findings).toContainEqual({
      table: '(schema rebook)',
      problem: 'anon has a privilege on the schema',
    });
  });

  it('is wired as `pnpm db:check-schema` and exits 0 on the real schema', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        'scripts/check-schema.ts',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/db:check-schema: every rebook table/);
  });
});
