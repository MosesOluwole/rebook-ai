/**
 * Tenancy module: identity, the tenant context, the runtime roles, authorisation and the core
 * tenant-owned tables (docs/architecture.md §4 and §5, docs/adr/ADR-002, ADR-003, ADR-004).
 *
 * Every query against tenant data runs through `withTenant` or `withWorkerTenant`, which open a
 * transaction as a NOBYPASSRLS role with the tenant context installed and hand repositories a
 * branded `TenantTx`. A signed-in user enters a tenant only through an `AuthorisedTenantContext`
 * from `resolveTenantForUser` (or the onboarding and invitation flows), and lists their own tenants
 * through `withUserContext`. Other modules reference these tables for composite foreign keys and
 * call the functions below; they never query `rebook` tables with a bare database handle.
 */
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { createSupabaseServerClient, type SessionCookies } from '@/shared/auth/supabase';
import { type Clock } from '@/shared/kernel/clock';

import {
  acceptInvitation,
  type CreatedInvitation,
  createInvitation,
} from './application/invitations';
import { listMyTenants, type MyTenant } from './application/my-tenants';
import { completeOnboarding, type OnboardingHooks } from './application/onboarding';
import { type AuthGateway } from './application/ports';
import { resolveTenantForUser } from './application/resolve-tenant';
import { type Tenant } from './domain/tenant';
import { type UserActor } from './domain/user';
import { invitationTokens, randomSlugSuffix } from './infrastructure/invitation-token';
import { type Membership } from './infrastructure/repositories/memberships';
import { createSupabaseAuthGateway } from './infrastructure/supabase-auth';
import {
  type AuthorisedTenantContext,
  createTenantRunner,
  type TenantRunner,
  type TenantTx,
} from './infrastructure/tenant-tx';
import { createUuidV7Generator } from './infrastructure/uuid-v7-generator';

// ---- Domain ------------------------------------------------------------------------------
export { ACTOR_KINDS, type ActorKind } from './domain/actor';
export {
  BUSINESS_TYPES,
  businessTypeChangeRefusal,
  businessTypeSchema,
  canChangeBusinessType,
  isBusinessType,
  isHealthBusiness,
  terminologyFor,
  type BusinessType,
  type BusinessTypeChangeRefusal,
  type Terminology,
} from './domain/business-type';
export {
  AlreadyMemberError,
  AuthProviderError,
  BusinessTypeChangeError,
  BusinessTypeLockedError,
  CannotRevokeSelfError,
  DuplicateInvitationError,
  EmailNotVerifiedError,
  FeatureDisabledError,
  HealthCustomFieldsError,
  InvalidCredentialsError,
  InvalidTokenError,
  NotFoundError,
  SlugUnavailableError,
  ValidationError,
} from './domain/errors';
export {
  featureFlagNameSchema,
  KNOWN_FEATURE_FLAGS,
  parseFeatureFlagName,
} from './domain/feature-flag';
export {
  INVITATION_TTL_MS,
  inviteInputSchema,
  invitationTokenSchema,
  judgeInvitation,
  parseInviteInput,
  type InviteInput,
} from './domain/invitation';
export { newLocationSchema, parseNewLocation } from './domain/location';
export {
  assertCan,
  can,
  MEMBERSHIP_ROLES,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  PermissionDeniedError,
  type MembershipRole,
  type Permission,
} from './domain/permissions';
export { RUNTIME_ROLES, type RuntimeRole } from './domain/runtime-role';
export { isSlug, slugify } from './domain/slug';
export {
  newTenantSchema,
  parseNewTenant,
  parseTenantSettings,
  SLUG_PATTERN,
  tenantSettingsSchema,
  timeZoneSchema,
  type NewTenant,
  type Tenant,
  type TenantSettings,
} from './domain/tenant';
export {
  parseTenantContext,
  TenantContextError,
  tenantContextSchema,
  type TenantContext,
} from './domain/tenant-context';
export { canonicalTimeZone, ICU_LEGACY_TO_IANA, isIanaTimeZone } from './domain/time-zone';
export {
  authenticatedUserSchema,
  parseUserActor,
  userActorSchema,
  type AuthenticatedUser,
  type UserActor,
} from './domain/user';

// ---- Application --------------------------------------------------------------------------
export {
  isFeatureEnabled,
  requireFlag,
  toggleFeatureFlag,
  type FlagChange,
} from './application/feature-flags';
export {
  listOpenInvitations,
  revokeInvitation,
  type CreatedInvitation,
  type Invitation,
} from './application/invitations';
export { requireId } from './application/ids';
export { listLocations } from './application/locations';
export { type OnboardingHooks } from './application/onboarding';
export { listMembers, revokeMember } from './application/members';
export { type MyTenant } from './application/my-tenants';
export { assertPermission } from './application/permissions-guard';
export {
  EMAIL_TOKEN_TYPES,
  type AuthGateway,
  type EmailTokenType,
  type SignUpOutcome,
} from './application/ports';
export {
  getCurrentTenant,
  updateBusinessSettings,
  type BusinessTypeGuard,
} from './application/settings';

// ---- Infrastructure -----------------------------------------------------------------------
export {
  auditLogsRepository,
  type AuditEntry,
  type NewAuditEntry,
} from './infrastructure/repositories/audit-logs';
export {
  locationsRepository,
  type Location,
  type NewLocation,
} from './infrastructure/repositories/locations';
export {
  membershipsRepository,
  type Membership,
  type NewMembership,
} from './infrastructure/repositories/memberships';
export { tenantsRepository } from './infrastructure/repositories/tenants';
// For other modules' application code that maps constraint violations to typed errors.
export {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  sqlStateOf,
  UNIQUE_VIOLATION,
  violatedConstraintOf,
} from './infrastructure/sql-errors';
// Table objects are exported so later modules can declare composite foreign keys
// (`foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] })`).
// Never query them directly: go through the repositories and application functions above.
export {
  auditLogs,
  idempotencyKeys,
  locations,
  rebook,
  tenantFeatureFlags,
  tenantInvitations,
  tenantMemberships,
  tenants,
} from './infrastructure/schema';
export {
  createTenantRunner,
  NestedTenantTransactionError,
  type AnonymousTx,
  type AnonymousWork,
  type AuthorisationGrant,
  type AuthorisedTenantContext,
  type DbTransaction,
  type TenantContextInput,
  type TenantRunner,
  type TenantTx,
  type TenantWork,
  type UnauthenticatedTenantContext,
  type UserTx,
  type UserWork,
} from './infrastructure/tenant-tx';
export { createUuidV7Generator } from './infrastructure/uuid-v7-generator';

export interface Tenancy {
  readonly runner: TenantRunner;
  readonly withTenant: TenantRunner['withTenant'];
  readonly withWorkerTenant: TenantRunner['withWorkerTenant'];
  readonly withUserContext: TenantRunner['withUserContext'];
  readonly withAnonymousContext: TenantRunner['withAnonymousContext'];
  /** Slug plus active membership → the user's authorised context; NotFoundError otherwise. */
  resolveTenantForUser(slug: string, actor: UserActor): Promise<AuthorisedTenantContext>;
  /** The tenants the user may switch to. */
  listMyTenants(actor: UserActor): Promise<MyTenant[]>;
  /** Tenant, default location and owner membership in one transaction; slug collisions retried. */
  completeOnboarding(input: unknown, actor: UserActor): Promise<Tenant>;
  /** Owner-only: an invitation plus the one-time token for its link. */
  createInvitation(tx: TenantTx, input: unknown): Promise<CreatedInvitation>;
  /** Follows an invite link as the signed-in user; idempotent; NotFoundError for every bad link. */
  acceptInvitation(slug: string, token: string, actor: UserActor): Promise<Membership>;
}

/**
 * Composition root: wires the runner, ids and tokens for a database connected as
 * rebook_authenticator. `hooks` come from the modules that depend on tenancy (booking's
 * `onboardingHooks`); they are required so no caller can forget them.
 */
export function createTenancy(
  db: PostgresJsDatabase,
  clock: Clock,
  hooks: OnboardingHooks,
): Tenancy {
  const runner = createTenantRunner(db);
  const ids = createUuidV7Generator(clock);
  return {
    runner,
    withTenant: (ctx, work) => runner.withTenant(ctx, work),
    withWorkerTenant: (ctx, work) => runner.withWorkerTenant(ctx, work),
    withUserContext: (actor, work) => runner.withUserContext(actor, work),
    withAnonymousContext: (requestId, work) => runner.withAnonymousContext(requestId, work),
    resolveTenantForUser: (slug, actor) => resolveTenantForUser({ runner }, slug, actor),
    listMyTenants: (actor) => listMyTenants({ runner }, actor),
    completeOnboarding: (input, actor) =>
      completeOnboarding({ runner, ids, slugSuffix: randomSlugSuffix, hooks }, input, actor),
    createInvitation: (tx, input) =>
      createInvitation({ clock, tokens: invitationTokens }, tx, input),
    acceptInvitation: (slug, token, actor) =>
      acceptInvitation({ runner, clock, tokens: invitationTokens }, slug, token, actor),
  };
}

/**
 * The authentication gateway for one request, over the session cookies the caller supplies.
 * Routes call `currentUser()` on every request; nothing trusts the cookie payload by itself.
 */
export function createAuthSession(cookies: SessionCookies): AuthGateway {
  return createSupabaseAuthGateway(createSupabaseServerClient(cookies));
}
