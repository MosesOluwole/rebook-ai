import { type NextRequest, type NextResponse } from 'next/server';

import { formMessage } from '../../_lib/form-errors';
import { rejectCrossOrigin, routeAnswer } from '../../_lib/http';
import { rateLimitOrNull } from '../../_lib/rate-limiter';
import { safeNextPath } from '../../_lib/safe-next';
import { getAuthSession } from '../../_lib/session';
import { emailOnlySchema, formField } from '../_lib';

export const dynamic = 'force-dynamic';

/** Sends a sign-in link. The same confirmation is shown whether or not the address exists. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const forbidden = rejectCrossOrigin(request);
  if (forbidden !== null) {
    return forbidden;
  }
  const form = await request.formData();
  const next = safeNextPath(formField(form, 'next'));
  const email = formField(form, 'email');

  const limited = await rateLimitOrNull(request, 'magic_link', email, '/sign-in');
  if (limited !== null) {
    return limited;
  }

  const parsed = emailOnlySchema.safeParse({ email });
  if (!parsed.success) {
    return routeAnswer(request, {
      ok: false,
      status: 400,
      message: 'Enter a valid email address for the sign-in link.',
      backTo: '/sign-in',
    });
  }
  const auth = await getAuthSession();
  try {
    await auth.sendMagicLink(parsed.data.email);
  } catch (error) {
    return routeAnswer(request, {
      ok: false,
      status: 400,
      message: formMessage(error),
      backTo: '/sign-in',
    });
  }
  return routeAnswer(request, {
    ok: true,
    status: 200,
    message: 'Check your email for a sign-in link. It works once and expires in an hour.',
    backTo: `/sign-in?next=${encodeURIComponent(next)}`,
  });
}
