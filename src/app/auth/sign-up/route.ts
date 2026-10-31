import { type NextRequest, type NextResponse } from 'next/server';

import { type SignUpOutcome } from '@/modules/tenancy';

import { formMessage } from '../../_lib/form-errors';
import { rejectCrossOrigin, routeAnswer } from '../../_lib/http';
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
    return routeAnswer(request, {
      ok: false,
      status: 400,
      message: 'Enter a valid email and a password of at least 8 characters.',
      backTo: '/sign-up',
    });
  }
  const auth = await getAuthSession();
  let outcome: SignUpOutcome;
  try {
    outcome = await auth.signUpWithPassword(parsed.data);
  } catch (error) {
    return routeAnswer(request, {
      ok: false,
      status: 400,
      message: formMessage(error),
      backTo: '/sign-up',
    });
  }
  if (outcome === 'confirmation_required') {
    return routeAnswer(request, {
      ok: true,
      status: 200,
      message: 'Check your email to confirm your address, then sign in.',
      backTo: '/sign-in',
    });
  }
  return routeAnswer(request, { redirect: next === '/app' ? '/onboarding' : next });
}
