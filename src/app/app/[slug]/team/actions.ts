'use server';

import { redirect } from 'next/navigation';

import { createTeamMember } from '@/modules/booking';
import { revokeInvitation, revokeMember } from '@/modules/tenancy';
import { appUrl } from '@/shared/config/app-url';

import { readString } from '../../../_lib/form-errors';
import { failed, type FormState, runForm } from '../../../_lib/form-state';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

/**
 * The invite link must reach the owner's browser without a redirect (a redirect would put the
 * secret in a URL and in server logs), so it comes back as form state, rendered in place.
 */
export async function createInviteAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      const { invitation, token } = await getTenancy().withTenant(ctx, (tx) =>
        getTenancy().createInvitation(tx, {
          email: readString(formData, 'email'),
          role: readString(formData, 'role'),
        }),
      );
      // On APP_ORIGIN whatever Host or X-Forwarded-Host this request carried (ADR-004 §9).
      const link = appUrl(`/invite/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`);
      return { message: 'Invite link created.', data: { link, email: invitation.email } };
    },
    { revalidate: [`/app/${slug}/team`] },
  );
}

export async function revokeInvitationAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) => revokeInvitation(tx, readString(formData, 'id')));
      return 'Invitation revoked.';
    },
    { revalidate: [`/app/${slug}/team`] },
  );
}

export async function revokeMemberAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) => revokeMember(tx, readString(formData, 'id')));
      return 'Member removed. Their team member profile stays, no longer linked to a sign-in.';
    },
    { revalidate: [`/app/${slug}/team`] },
  );
}

/** Phase 3: a team member (who delivers services), optionally linked to a membership. */
export async function createTeamMemberAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  let memberId: string;
  try {
    const member = await getTenancy().withTenant(ctx, (tx) =>
      createTeamMember(tx, {
        displayName: readString(formData, 'displayName'),
        membershipId: readString(formData, 'membershipId'),
      }),
    );
    memberId = member.id;
  } catch (error) {
    return failed(previous, formData, error);
  }
  redirect(`/app/${slug}/team/${memberId}`);
}
