import Link from 'next/link';
import { notFound } from 'next/navigation';

import { invitationTokenSchema, isSlug } from '@/modules/tenancy';

import { RouteForm, SubmitButton } from '../../../_components/forms';
import { requireUser } from '../../../_lib/session';

export const dynamic = 'force-dynamic';

/**
 * Landing page of an invite link. Acceptance happens on the button, not on the GET, so a mail
 * scanner that follows the link cannot join anyone to anything. The business is named by its
 * address only: the user is not a member yet, so nothing else about it is readable.
 */
export default async function InvitePage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
}) {
  const { slug, token } = await params;
  if (!isSlug(slug) || !invitationTokenSchema.safeParse(token).success) {
    notFound();
  }
  const user = await requireUser(`/invite/${slug}/${token}`);

  return (
    <main>
      <h1>You have been invited</h1>
      <p>
        Join the business at <code>/app/{slug}</code> as <strong>{user.email}</strong>.
      </p>
      {/* Not verified yet, already a member, or a bad link: answered as form state. */}
      <RouteForm endpoint={`/invite/${slug}/${token}/accept`} label="Accept invitation">
        <div>
          <SubmitButton>Accept invitation</SubmitButton>
        </div>
      </RouteForm>
      <p className="muted">
        <Link href={`/app/${slug}`}>Open the business</Link> if you are already a member.
      </p>
      <p className="muted">
        Not you? Sign out from the workspace menu and sign in with the invited address.
      </p>
    </main>
  );
}
