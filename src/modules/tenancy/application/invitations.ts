import { type Clock } from '@/shared/kernel/clock';

import {
  AlreadyMemberError,
  DuplicateInvitationError,
  EmailNotVerifiedError,
  NotFoundError,
} from '../domain/errors';
import {
  INVITATION_TTL_MS,
  invitationTokenSchema,
  judgeInvitation,
  parseInviteInput,
} from '../domain/invitation';
import { isSlug } from '../domain/slug';
import { type UserActor } from '../domain/user';
import { authoriseInvitation } from '../infrastructure/authorised-context';
import { type InvitationTokens } from '../infrastructure/invitation-token';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { type Invitation, invitationsRepository } from '../infrastructure/repositories/invitations';
import { type Membership, membershipsRepository } from '../infrastructure/repositories/memberships';
import { tenantSlugsRepository } from '../infrastructure/repositories/tenant-slugs';
import { sqlStateOf, UNIQUE_VIOLATION, violatedConstraintOf } from '../infrastructure/sql-errors';
import { type TenantRunner, type TenantTx } from '../infrastructure/tenant-tx';
import { assertPermission } from './permissions-guard';

export type { Invitation };

export interface InvitationDeps {
  readonly clock: Clock;
  readonly tokens: InvitationTokens;
}

export interface CreatedInvitation {
  readonly invitation: Invitation;
  /** The secret for the link. Returned once; only its hash is stored. */
  readonly token: string;
}

/**
 * Owner-only. The caller builds the link from the tenant slug and the returned token. One open
 * invitation per address: a second one is refused (DuplicateInvitationError) until the first is
 * accepted, revoked or expired (an expired one is closed and replaced here); the partial unique
 * index settles the race between two owners.
 */
export async function createInvitation(
  deps: InvitationDeps,
  tx: TenantTx,
  input: unknown,
): Promise<CreatedInvitation> {
  assertPermission(tx, 'members.invite');
  const invite = parseInviteInput(input);
  if (tx.ctx.actorId === null) {
    // Unreachable after assertPermission (only a member has a role), kept explicit.
    throw new Error('createInvitation requires a user actor');
  }
  const open = await invitationsRepository.findOpenByEmail(tx, invite.email);
  if (open !== null) {
    if (open.expiresAt.getTime() > deps.clock.now().getTime()) {
      throw new DuplicateInvitationError();
    }
    // An expired invitation nobody revoked must not block the address for ever: it is closed
    // here, audited, and replaced by the new one.
    await invitationsRepository.revoke(tx, open.id);
    await auditLogsRepository.append(tx, {
      action: 'invitation.revoked',
      entityType: 'tenant_invitation',
      entityId: open.id,
      before: { role: open.role },
      after: { reason: 'expired, replaced' },
    });
  }
  const { token, tokenHash } = deps.tokens.generate();
  let invitation: Invitation;
  try {
    invitation = await invitationsRepository.insert(tx, {
      email: invite.email,
      role: invite.role,
      tokenHash,
      invitedBy: tx.ctx.actorId,
      expiresAt: new Date(deps.clock.now().getTime() + INVITATION_TTL_MS),
    });
  } catch (error) {
    if (
      sqlStateOf(error) === UNIQUE_VIOLATION &&
      violatedConstraintOf(error) === 'tenant_invitations_open_email_unique'
    ) {
      throw new DuplicateInvitationError();
    }
    throw error;
  }
  await auditLogsRepository.append(tx, {
    action: 'invitation.created',
    entityType: 'tenant_invitation',
    entityId: invitation.id,
    after: { role: invitation.role, expiresAt: invitation.expiresAt.toISOString() },
  });
  return { invitation, token };
}

/** Owner-only: invitations that are neither accepted nor revoked. */
export function listOpenInvitations(tx: TenantTx): Promise<Invitation[]> {
  assertPermission(tx, 'members.invite');
  return invitationsRepository.listOpen(tx);
}

/** Owner-only. Revoking an invitation that is not open is a NotFoundError (no oracle). */
export async function revokeInvitation(tx: TenantTx, invitationId: string): Promise<Invitation> {
  assertPermission(tx, 'members.revoke');
  const revoked = await invitationsRepository.revoke(tx, invitationId);
  if (revoked === null) {
    throw new NotFoundError();
  }
  await auditLogsRepository.append(tx, {
    action: 'invitation.revoked',
    entityType: 'tenant_invitation',
    entityId: revoked.id,
    before: { role: revoked.role },
  });
  return revoked;
}

export interface AcceptInvitationDeps {
  readonly runner: Pick<TenantRunner, 'withTenant' | 'withUserContext'>;
  readonly clock: Clock;
  readonly tokens: InvitationTokens;
}

/**
 * A signed-in user follows an invite link `/invite/<slug>/<token>`. The slug is resolved under the
 * user's own context; the invitation is then checked and the membership created under the
 * invitation grant, in one transaction. Idempotent: a second acceptance by the same user returns
 * the existing membership. An active member accepting a different invitation is told they are
 * already a member (AlreadyMemberError) and nothing changes. Every way the link can be wrong is
 * the same NotFoundError (docs/phases.md Phase 2); only "verify your email" and "already a
 * member" are distinguishable, and only for the addressee.
 */
export async function acceptInvitation(
  deps: AcceptInvitationDeps,
  slug: string,
  token: string,
  actor: UserActor,
): Promise<Membership> {
  if (!isSlug(slug) || !invitationTokenSchema.safeParse(token).success) {
    throw new NotFoundError();
  }
  const tenantId = await deps.runner.withUserContext(actor, (tx) =>
    tenantSlugsRepository.resolve(tx, slug),
  );
  if (tenantId === null) {
    throw new NotFoundError();
  }
  const tokenHash = deps.tokens.hash(token);

  return deps.runner.withTenant(
    authoriseInvitation(actor.user, actor.requestId, tenantId),
    async (tx) => {
      // Row lock: concurrent acceptances of one link (a double click) serialise here.
      const invitation = await invitationsRepository.findByTokenHashForUpdate(tx, tokenHash);
      if (invitation === null) {
        throw new NotFoundError();
      }
      const verdict = judgeInvitation(invitation, actor.user, deps.clock.now());
      const existing = await membershipsRepository.findForUser(tx, actor.user.id);

      switch (verdict) {
        case 'rejected':
          throw new NotFoundError();
        case 'email_not_verified':
          throw new EmailNotVerifiedError();
        case 'already_accepted_by_user':
          if (existing?.revokedAt === null) {
            return existing;
          }
          // Accepted before but the membership was revoked since: the link no longer admits.
          throw new NotFoundError();
        case 'acceptable': {
          // An active member cannot accept another invitation: the role never changes this way
          // and the owner is told at invite time (DuplicateInvitationError) or here.
          if (existing?.revokedAt === null) {
            throw new AlreadyMemberError();
          }
          // Two different invitations for the same address may be accepted at the same time;
          // the second insert finds the first one's row instead of raising a unique violation.
          const membership =
            existing === null
              ? await membershipsRepository.insertOrExisting(tx, {
                  userId: actor.user.id,
                  role: invitation.role,
                })
              : await membershipsRepository.reactivate(tx, existing.id, invitation.role);
          await invitationsRepository.markAccepted(tx, invitation.id, actor.user.id);
          await auditLogsRepository.append(tx, {
            action: 'invitation.accepted',
            entityType: 'tenant_invitation',
            entityId: invitation.id,
            after: {
              invitedRole: invitation.role,
              role: membership.role,
              membershipId: membership.id,
            },
          });
          if (existing === null) {
            await auditLogsRepository.append(tx, {
              action: 'membership.created',
              entityType: 'tenant_membership',
              entityId: membership.id,
              after: { role: membership.role, via: 'invitation' },
            });
          } else {
            // Only a revoked membership reaches this point: active members were refused above.
            await auditLogsRepository.append(tx, {
              action: 'membership.reactivated',
              entityType: 'tenant_membership',
              entityId: membership.id,
              before: { role: existing.role, active: false },
              after: { role: membership.role, active: true, via: 'invitation' },
            });
          }
          return membership;
        }
      }
    },
  );
}
