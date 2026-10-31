import { z } from 'zod';

import { ValidationError } from './errors';
import { MEMBERSHIP_ROLES } from './permissions';

/** Invitations expire a week after they are created. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 256 random bits, base64url: 43 characters. Only its SHA-256 is stored. */
export const INVITATION_TOKEN_BYTES = 32;
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const inviteInputSchema = z.strictObject({
  // Trim and lower-case before the format check: Zod 4 runs `z.email()` on the raw value.
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: z.enum(MEMBERSHIP_ROLES),
});

export type InviteInput = z.infer<typeof inviteInputSchema>;

export function parseInviteInput(input: unknown): InviteInput {
  const result = inviteInputSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'invitation',
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || 'invitation'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

export interface InvitationState {
  readonly email: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedBy: string | null;
  readonly revokedAt: Date | null;
}

export interface AcceptingUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export type InvitationVerdict =
  /** Open, unexpired, addressed to this verified user. */
  | 'acceptable'
  /** This same user already accepted it: idempotent success, nothing to create. */
  | 'already_accepted_by_user'
  /** Revoked, expired, used by someone else, or for a different address: identical 404. */
  | 'rejected'
  /** Addressed to this user, but their email is not verified yet. */
  | 'email_not_verified';

/** Pure decision; the application layer turns it into effects. */
export function judgeInvitation(
  invitation: InvitationState,
  user: AcceptingUser,
  now: Date,
): InvitationVerdict {
  if (invitation.revokedAt !== null) {
    return 'rejected';
  }
  if (invitation.acceptedAt !== null) {
    return invitation.acceptedBy === user.id ? 'already_accepted_by_user' : 'rejected';
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return 'rejected';
  }
  if (invitation.email !== user.email.trim().toLowerCase()) {
    return 'rejected';
  }
  if (!user.emailVerified) {
    return 'email_not_verified';
  }
  return 'acceptable';
}
