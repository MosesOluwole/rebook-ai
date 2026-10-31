import { type NextRequest, type NextResponse } from 'next/server';

import { formMessage } from '../../_lib/form-errors';
import { backToForm, rejectCrossOrigin } from '../../_lib/http';
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
    return backToForm('/sign-in', {
      error: 'Enter a valid email address for the sign-in link.',
      next,
    });
  }
  const auth = await getAuthSession();
  try {
    await auth.sendMagicLink(parsed.data.email);
  } catch (error) {
    return backToForm('/sign-in', { error: formMessage(error), next });
  }
  return backToForm('/sign-in', { sent: '1', next });
}
