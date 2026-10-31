import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError } from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  createAuthUser,
  type FixtureUser,
  removeAuthUsers,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * resolveTenantForUser (docs/architecture.md §4, docs/phases.md Phase 2): the tenant comes from
 * the URL slug checked against an active membership, and a member of tenant A asking for tenant
 * B's slug gets exactly the same 404 as a slug that does not exist.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
let outsider: FixtureUser;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'rt');
  outsider = await createAuthUser(owner, 'outsider');
});

afterAll(async () => {
  await pair.cleanup();
  await removeAuthUsers(owner, [outsider.id]);
  await app.close();
  await owner.close();
});

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('resolveTenantForUser', () => {
  it('returns an authorised context for an active member, carrying user, role and grant', async () => {
    const actor = actorFor(pair.a, { requestId: 'resolve-1' });
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actor);
    expect(ctx).toMatchObject({
      tenantId: pair.a.id,
      actorKind: 'user',
      actorId: pair.a.userId,
      requestId: 'resolve-1',
      user: actor.user,
      role: 'owner',
      grant: 'membership',
    });
    const rows = await app.tenancy.withTenant(ctx, (tx) =>
      tx.db.execute<{ id: string }>(sql`select id from rebook.locations`),
    );
    expect(rows.map((row) => row.id)).toEqual([pair.a.locationId]);
  });

  it('gives a member of tenant A the very same error for tenant B slug as for a slug that does not exist', async () => {
    const actor = actorFor(pair.a);
    const otherTenant = await failureOf(app.tenancy.resolveTenantForUser(pair.b.slug, actor));
    const noSuchSlug = await failureOf(
      app.tenancy.resolveTenantForUser(`${pair.b.slug}-does-not-exist`, actor),
    );

    expect(otherTenant).toBeInstanceOf(NotFoundError);
    expect(noSuchSlug).toBeInstanceOf(NotFoundError);
    const shape = (error: unknown) => ({
      name: (error as Error).name,
      message: (error as Error).message,
      ownProperties: Object.getOwnPropertyNames(error).sort(),
      enumerable: { ...(error as object) },
    });
    expect(shape(otherTenant)).toEqual(shape(noSuchSlug));
  });

  it.each(['', 'Not A Slug', '-leading', 'a'.repeat(64), '../etc'])(
    'treats the malformed slug %j as not found without touching the database',
    async (slug) => {
      await expect(app.tenancy.resolveTenantForUser(slug, actorFor(pair.a))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    },
  );

  it('does not admit a user with no membership at all, nor a revoked one', async () => {
    await expect(
      app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(outsider)),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [membership] = await owner.sql<{ id: string }[]>`
      insert into rebook.tenant_memberships (tenant_id, user_id, role)
      values (${pair.a.id}, ${outsider.id}, 'staff') returning id
    `;
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(outsider));
    expect(ctx.role).toBe('staff');

    await owner.sql`update rebook.tenant_memberships set revoked_at = now() where id = ${membership?.id ?? ''}`;
    await expect(
      app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(outsider)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
