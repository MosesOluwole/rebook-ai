import { type NextRequest, type NextResponse } from 'next/server';

import { type SignUpOutcome } from '@/modules/tenancy';

import { formMessage } from '../../_lib/form-errors';
import { backToForm, rejectCrossOrigin, seeOther } from '../../_lib/http';
import { rateLimitOrNull } from '../../_lib/rate-limiter';
import { safeNextPath } from '../../_lib/safe-next';
import { getAuthSession } from '../../_lib/session';
import { credentialsSchema, formField } from '../_lib';

export const dynamic = 'force-dynamic';

/** Creates the auth user. Onboarding (the business) is the next step, in its own transaction. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const forbidden = rejectCrossOrigin(request);
  if (forbidden !== null) {
    return forbidden;
  }
  const form = await request.formData();
  const next = safeNextPath(formField(form, 'next'));
  const email = formField(form, 'email');

  const limited = await rateLimitOrNull(request, 'sign_up', email, '/sign-up');
  if (limited !== null) {
    return limited;
  }

  const parsed = credentialsSchema.safeParse({ email, password: formField(form, 'password') });
  if (!parsed.success) {
    return backToForm('/sign-up', {
      error: 'Enter a valid email and a password of at least 8 characters.',
      next,
    });
  }
  const auth = await getAuthSession();
  let outcome: SignUpOutcome;
  try {
    outcome = await auth.signUpWithPassword(parsed.data);
  } catch (error) {
    return backToForm('/sign-up', { error: formMessage(error), next });
  }
  if (outcome === 'confirmation_required') {
    return backToForm('/sign-up', { 'check-email': '1' });
  }
  return seeOther(next === '/app' ? '/onboarding' : next);
}
