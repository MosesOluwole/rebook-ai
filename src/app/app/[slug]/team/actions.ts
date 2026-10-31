'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { NotFoundError, revokeInvitation, revokeMember } from '@/modules/tenancy';
import { getEnv } from '@/shared/config/env';

import { formMessage, readString } from '../../../_lib/form-errors';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

export interface InviteFormState {
  readonly status: 'idle' | 'ok' | 'error';
  /** The invite link, returned once to the owner's browser; the token is not stored. */
  readonly link?: string;
  readonly email?: string;
  readonly message?: string;
}

export async function createInviteAction(
  _previous: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  try {
    const { invitation, token } = await getTenancy().withTenant(ctx, (tx) =>
      getTenancy().createInvitation(tx, {
        email: readString(formData, 'email'),
        role: readString(formData, 'role'),
      }),
    );
    const link = new URL(`/invite/${slug}/${token}`, getEnv().NEXT_PUBLIC_APP_URL).toString();
    // The page's server-rendered "Open invitations" list must show the new row without a reload.
    revalidatePath(`/app/${slug}/team`);
    return { status: 'ok', link, email: invitation.email };
  } catch (error) {
    return { status: 'error', message: formMessage(error) };
  }
}

/** A row id from a form. Anything that is not a UUID is "not found", never a database error. */
function readId(formData: FormData): string {
  const parsed = z.uuid().safeParse(readString(formData, 'id'));
  if (!parsed.success) {
    throw new NotFoundError();
  }
  return parsed.data;
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  let message = 'Invitation revoked.';
  try {
    const id = readId(formData);
    await getTenancy().withTenant(ctx, (tx) => revokeInvitation(tx, id));
  } catch (error) {
    message = formMessage(error);
  }
  redirect(`/app/${slug}/team?notice=${encodeURIComponent(message)}`);
}

export async function revokeMemberAction(formData: FormData): Promise<void> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  let message = 'Member removed.';
  try {
    const id = readId(formData);
    await getTenancy().withTenant(ctx, (tx) => revokeMember(tx, id));
  } catch (error) {
    message = formMessage(error);
  }
  redirect(`/app/${slug}/team?notice=${encodeURIComponent(message)}`);
}
