import { type MembershipRole } from '../domain/permissions';
import { type AuthenticatedUser } from '../domain/user';
import { type AuthorisedTenantContext } from './tenant-tx';

/**
 * The only constructors of `AuthorisedTenantContext`. Not exported from the module's index, so
 * routes and other modules can obtain one solely from `resolveTenantForUser`, onboarding or
 * invite acceptance (docs/adr/ADR-004-auth-sessions.md).
 */

function mint(
  user: AuthenticatedUser,
  requestId: string,
  tenantId: string,
  role: MembershipRole | null,
  grant: AuthorisedTenantContext['grant'],
): AuthorisedTenantContext {
  return {
    tenantId,
    actorKind: 'user',
    actorId: user.id,
    requestId,
    user,
    role,
    grant,
  } as AuthorisedTenantContext;
}

/** Proven by an active membership row read under the user's own context. */
export function authoriseByMembership(
  user: AuthenticatedUser,
  requestId: string,
  tenantId: string,
  role: MembershipRole,
): AuthorisedTenantContext {
  return mint(user, requestId, tenantId, role, 'membership');
}

/** For the single transaction that creates a tenant with this user as its first owner. */
export function authoriseRegistration(
  user: AuthenticatedUser,
  requestId: string,
  tenantId: string,
): AuthorisedTenantContext {
  return mint(user, requestId, tenantId, null, 'registration');
}

/** For the single transaction that checks an invitation token and creates the membership. */
export function authoriseInvitation(
  user: AuthenticatedUser,
  requestId: string,
  tenantId: string,
): AuthorisedTenantContext {
  return mint(user, requestId, tenantId, null, 'invitation');
}
