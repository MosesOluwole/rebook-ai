import { type NextRequest, type NextResponse } from 'next/server';
import { notFound } from 'next/navigation';

import { AlreadyMemberError, EmailNotVerifiedError } from '@/modules/tenancy';

import { isNotFound, isTypedError } from '../../../../_lib/form-errors';
import { rejectCrossOrigin, seeOther } from '../../../../_lib/http';
import { rateLimitOrNull } from '../../../../_lib/rate-limiter';
import { actorFor, currentUser, getAuthSession } from '../../../../_lib/session';
import { getTenancy } from '../../../../_lib/tenancy';

export const dynamic = 'force-dynamic';

/**
 * Accepts the invitation for the signed-in user. The email is re-read from the auth provider so
 * "verified" means verified now; the attempt is rate limited per IP and per that address.
 */
export async function POST(
  request: NextRequest,
  { params }: { readonly params: Promise<{ readonly slug: string; readonly token: string }> },
): Promise<NextResponse> {
  const forbidden = rejectCrossOrigin(request);
  if (forbidden !== null) {
    return forbidden;
  }
  const { slug, token } = await params;
  const path = `/invite/${slug}/${token}`;
  const sessionUser = await currentUser();
  if (sessionUser === null) {
    return seeOther(`/sign-in?next=${encodeURIComponent(path)}`);
  }

  // Counted on the session's address before the fresh (verified) read of the user, so the
  // limiter sits in front of the auth round trip as well as in front of the token check.
  const limited = await rateLimitOrNull(request, 'invite_accept', sessionUser.email, path);
  if (limited !== null) {
    return limited;
  }

  const auth = await getAuthSession();
  const user = await auth.currentUserVerified();
  if (user === null) {
    return seeOther(`/sign-in?next=${encodeURIComponent(path)}`);
  }

  try {
    await getTenancy().acceptInvitation(slug, token, actorFor(user));
  } catch (error) {
    if (isNotFound(error)) {
      notFound();
    }
    if (isTypedError(error, EmailNotVerifiedError)) {
      return seeOther(`${path}?verify=1`);
    }
    if (isTypedError(error, AlreadyMemberError)) {
      return seeOther(`${path}?member=1`);
    }
    throw error;
  }
  return seeOther(`/app/${slug}`);
}
