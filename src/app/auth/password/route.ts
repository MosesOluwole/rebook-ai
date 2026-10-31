import { type NextRequest, type NextResponse } from 'next/server';

import { formMessage } from '../../_lib/form-errors';
import { backToForm, rejectCrossOrigin, seeOther } from '../../_lib/http';
import { rateLimitOrNull } from '../../_lib/rate-limiter';
import { safeNextPath } from '../../_lib/safe-next';
import { getAuthSession } from '../../_lib/session';
import { credentialsSchema, formField } from '../_lib';

export const dynamic = 'force-dynamic';

/** Password sign-in. A route handler rather than a server action so a refused attempt is a real 429. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const forbidden = rejectCrossOrigin(request);
  if (forbidden !== null) {
    return forbidden;
  }
  const form = await request.formData();
  const next = safeNextPath(formField(form, 'next'));
  const email = formField(form, 'email');

  const limited = await rateLimitOrNull(request, 'sign_in', email, '/sign-in');
  if (limited !== null) {
    return limited;
  }

  const parsed = credentialsSchema.safeParse({ email, password: formField(form, 'password') });
  if (!parsed.success) {
    return backToForm('/sign-in', {
      error: 'Enter your email and a password of at least 8 characters.',
      next,
    });
  }
  const auth = await getAuthSession();
  try {
    await auth.signInWithPassword(parsed.data);
  } catch (error) {
    return backToForm('/sign-in', { error: formMessage(error), next });
  }
  return seeOther(next);
}
