/**
 * OWNER-ONLY FIXTURES. Everything here runs as Supabase's `postgres` role through the owner
 * connection, bypassing RLS, to put two tenants' rows (and the Supabase Auth users they need) in
 * place. Tests then prove, through the app connection and withTenant, that tenant A cannot see or
 * touch tenant B. Nothing in this file may be used to assert behaviour; it only arranges data and
 * removes it again. Emails are synthetic (`@example.invalid`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { type DbClient } from '@/shared/db/client';

import { type UnauthenticatedTenantContext, type UserActor } from '@/modules/tenancy';

export interface FixtureUser {
  readonly id: string;
  readonly email: string;
}

export interface SeededTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The owner member's auth user. */
  readonly userId: string;
  readonly email: string;
  /** An auth user with no membership anywhere, for rows that need a real user id. */
  readonly spareUserId: string;
  readonly spareEmail: string;
  readonly locationId: string;
  readonly membershipId: string;
  readonly auditLogId: string;
  readonly idempotencyKeyId: string;
  readonly invitationId: string;
  /** The secret of the seeded open invitation (its hash is what is stored). */
  readonly invitationToken: string;
  readonly invitationEmail: string;
  readonly flag: string;
}

export interface TenantPair {
  readonly a: SeededTenant;
  readonly b: SeededTenant;
  cleanup(): Promise<void>;
}

/** Inserts a confirmed Supabase Auth user directly (GoTrue is not involved). */
export async function createAuthUser(owner: DbClient, label = 'user'): Promise<FixtureUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.invalid`;
  await owner.sql`
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email},
      '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      false, false
    )
  `;
  return { id, email };
}

/** Deleting an auth user cascades to its memberships and nulls invitation references. */
export async function removeAuthUsers(owner: DbClient, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  await owner.sql`delete from auth.users where id = any(${[...userIds]}::uuid[])`;
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
      await removeAuthUsers(owner, [a.userId, a.spareUserId, b.userId, b.spareUserId]);
    },
  };
}

async function seedTenant(owner: DbClient, slug: string): Promise<SeededTenant> {
  const user = await createAuthUser(owner, 'owner');
  const spare = await createAuthUser(owner, 'spare');
  const flag = 'fixture_flag';
  const name = `Fixture ${slug}`;
  const [tenant] = await owner.sql<{ id: string }[]>`
    insert into rebook.tenants (name, slug, business_type, time_zone)
    values (${name}, ${slug}, 'other_timed', 'Europe/London')
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
    values (${tenant.id}, ${user.id}, 'owner')
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
  const invitationToken = randomBytes(32).toString('base64url');
  const invitationEmail = `invitee-${slug}@example.invalid`;
  const [invitation] = await owner.sql<{ id: string }[]>`
    insert into rebook.tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${tenant.id}, ${invitationEmail}, 'staff', ${hashToken(invitationToken)}, ${user.id}, now() + interval '7 days')
    returning id
  `;
  await owner.sql`
    insert into rebook.tenant_feature_flags (tenant_id, flag, enabled)
    values (${tenant.id}, ${flag}, true)
  `;
  if (!location || !membership || !auditLog || !idempotencyKey || !invitation) {
    throw new Error('fixture: a child insert returned no row');
  }
  return {
    id: tenant.id,
    slug,
    name,
    userId: user.id,
    email: user.email,
    spareUserId: spare.id,
    spareEmail: spare.email,
    locationId: location.id,
    membershipId: membership.id,
    auditLogId: auditLog.id,
    idempotencyKeyId: idempotencyKey.id,
    invitationId: invitation.id,
    invitationToken,
    invitationEmail,
    flag,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Removes every row of the given tenants from every tenant-owned table, children first. */
export async function removeTenants(owner: DbClient, tenantIds: readonly string[]): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  const ids = [...tenantIds];
  await owner.sql`delete from rebook.tenant_invitations where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.idempotency_keys where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenant_feature_flags where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.audit_logs where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenant_memberships where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.locations where tenant_id = any(${ids}::uuid[])`;
  await owner.sql`delete from rebook.tenants where id = any(${ids}::uuid[])`;
}

/**
 * A tenant context for a non-user actor (the system by default). User actors cannot be built
 * here: they come from `tenancy.resolveTenantForUser(slug, actorFor(seed))`, the production path.
 */
export function contextFor(
  tenantId: string,
  overrides: Partial<Omit<UnauthenticatedTenantContext, 'tenantId'>> = {},
): UnauthenticatedTenantContext {
  return {
    tenantId,
    actorKind: 'system',
    actorId: null,
    requestId: `test-${randomUUID()}`,
    ...overrides,
  };
}

/** The signed-in user behind a seeded owner (or any fixture user), as the app would see them. */
export function actorFor(
  user: { readonly userId: string; readonly email: string } | FixtureUser,
  overrides: { readonly emailVerified?: boolean; readonly requestId?: string } = {},
): UserActor {
  const id = 'userId' in user ? user.userId : user.id;
  return {
    user: { id, email: user.email, emailVerified: overrides.emailVerified ?? true },
    requestId: overrides.requestId ?? `test-${randomUUID()}`,
  };
}
