/**
 * OWNER-ONLY FIXTURES. Everything here runs as Supabase's `postgres` role through the owner
 * connection, bypassing RLS, to put two tenants' rows in place. Tests then prove, through the
 * app connection and withTenant, that tenant A cannot see or touch tenant B. Nothing in this file
 * may be used to assert behaviour; it only arranges data and removes it again.
 */
import { randomUUID } from 'node:crypto';

import { type DbClient } from '@/shared/db/client';

import { type TenantContext } from '@/modules/tenancy';

export interface SeededTenant {
  readonly id: string;
  readonly slug: string;
  readonly userId: string;
  readonly locationId: string;
  readonly membershipId: string;
  readonly auditLogId: string;
  readonly idempotencyKeyId: string;
  readonly flag: string;
}

export interface TenantPair {
  readonly a: SeededTenant;
  readonly b: SeededTenant;
  cleanup(): Promise<void>;
}

/** Seeds one row in every tenant-owned table for two tenants and returns their ids. */
export async function seedTenantPair(owner: DbClient, label = 'iso'): Promise<TenantPair> {
  const stamp = randomUUID().slice(0, 8);
  const a = await seedTenant(owner, `${label}-a-${stamp}`);
  const b = await seedTenant(owner, `${label}-b-${stamp}`);
  return {
    a,
    b,
    cleanup: async () => {
      await removeTenants(owner, [a.id, b.id]);
    },
  };
}

async function seedTenant(owner: DbClient, slug: string): Promise<SeededTenant> {
  const userId = randomUUID();
  const flag = 'fixture_flag';
  const [tenant] = await owner.sql<{ id: string }[]>`
    insert into rebook.tenants (name, slug, time_zone)
    values (${`Fixture ${slug}`}, ${slug}, 'Europe/London')
    returning id
  `;
  if (tenant === undefined) {
    throw new Error('fixture: tenant insert returned no row');
  }
  const [location] = await owner.sql<{ id: string }[]>`
    insert into rebook.locations (tenant_id, name, time_zone)
    values (${tenant.id}, 'Fixture clinic', 'Europe/London')
    returning id
  `;
  const [membership] = await owner.sql<{ id: string }[]>`
    insert into rebook.tenant_memberships (tenant_id, user_id, role)
    values (${tenant.id}, ${userId}, 'owner')
    returning id
  `;
  const [auditLog] = await owner.sql<{ id: string }[]>`
    insert into rebook.audit_logs (tenant_id, actor_kind, actor_id, request_id, action, entity_type, entity_id, after)
    values (${tenant.id}, 'system', null, 'fixture', 'tenant.created', 'tenant', ${tenant.id}, '{"fixture": true}'::jsonb)
    returning id
  `;
  const [idempotencyKey] = await owner.sql<{ id: string }[]>`
    insert into rebook.idempotency_keys (tenant_id, scope, key, request_hash, expires_at)
    values (${tenant.id}, 'fixture.scope', ${`key-${slug}`}, 'hash', now() + interval '1 day')
    returning id
  `;
  await owner.sql`
    insert into rebook.tenant_feature_flags (tenant_id, flag, enabled)
    values (${tenant.id}, ${flag}, true)
  `;
  if (!location || !membership || !auditLog || !idempotencyKey) {
    throw new Error('fixture: a child insert returned no row');
  }
  return {
    id: tenant.id,
    slug,
    userId,
    locationId: location.id,
    membershipId: membership.id,
    auditLogId: auditLog.id,
    idempotencyKeyId: idempotencyKey.id,
    flag,
  };
}

/** Removes every row of the given tenants from every tenant-owned table, children first. */
export async function removeTenants(owner: DbClient, tenantIds: readonly string[]): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  const ids = [...tenantIds];
  await owner.sql`delete from rebook.idempotency_keys where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenant_feature_flags where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.audit_logs where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenant_memberships where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.locations where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenants where id = any(${ids}::uuid[])`;
}

/** A valid tenant context for tests: a staff user of the given tenant unless overridden. */
export function contextFor(
  tenantId: string,
  overrides: Partial<Omit<TenantContext, 'tenantId'>> = {},
): TenantContext {
  return {
    tenantId,
    actorKind: 'user',
    actorId: randomUUID(),
    requestId: `test-${randomUUID()}`,
    ...overrides,
  };
}
