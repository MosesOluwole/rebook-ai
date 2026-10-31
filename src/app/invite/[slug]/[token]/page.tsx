import Link from 'next/link';
import { notFound } from 'next/navigation';

import { invitationTokenSchema, isSlug } from '@/modules/tenancy';

import { requireUser } from '../../../_lib/session';

export const dynamic = 'force-dynamic';

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Landing page of an invite link. Acceptance happens on the button, not on the GET, so a mail
 * scanner that follows the link cannot join anyone to anything. The business is named by its
 * address only: the user is not a member yet, so nothing else about it is readable.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
  readonly searchParams: Promise<{
    readonly verify?: string | string[];
    readonly member?: string | string[];
  }>;
}) {
  const [{ slug, token }, query] = await Promise.all([params, searchParams]);
  if (!isSlug(slug) || !invitationTokenSchema.safeParse(token).success) {
    notFound();
  }
  const user = await requireUser(`/invite/${slug}/${token}`);
  const needsVerification = first(query.verify) === '1';
  const alreadyMember = first(query.member) === '1';

  return (
    <main>
      <h1>You have been invited</h1>
      <p>
        Join the business at <code>/app/{slug}</code> as <strong>{user.email}</strong>.
      </p>
      {needsVerification && (
        <p className="notice error" role="alert">
          Verify your email address first, then come back to this link.
        </p>
      )}
      {alreadyMember && (
        <p className="notice" role="status">
          You are already a member of this business. <Link href={`/app/${slug}`}>Open it</Link>.
        </p>
      )}
      <form action={`/invite/${slug}/${token}/accept`} method="post">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="token" value={token} />
        <button type="submit">Accept invitation</button>
      </form>
      <p className="muted">
        Not you? Sign out from the workspace menu and sign in with the invited address.
      </p>
    </main>
  );
}
