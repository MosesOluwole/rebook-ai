import { type NextRequest, type NextResponse } from 'next/server';
import { z } from 'zod';

import { EMAIL_TOKEN_TYPES, InvalidTokenError } from '@/modules/tenancy';

import { isTypedError } from '../../_lib/form-errors';
import { temporaryRedirect } from '../../_lib/http';
import { safeNextPath } from '../../_lib/safe-next';
import { getAuthSession } from '../../_lib/session';

export const dynamic = 'force-dynamic';

const query = z.object({
  token_hash: z.string().min(16).max(512),
  type: z.enum(EMAIL_TOKEN_TYPES),
  next: z.string().optional(),
});

/**
 * Lands every email link (magic link, sign-up confirmation): the token hash in the link is
 * verified server-side, which sets the session cookies, and the user continues to `next` (same
 * origin only). The browser never exchanges anything with Supabase itself.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = query.safeParse(params);
  // Path-relative redirects: behind a proxy `request.nextUrl` carries the listen host, not ours.
  const failed = `/sign-in?${new URLSearchParams({ error: 'This link is invalid or has expired. Request a new one.' }).toString()}`;
  if (!parsed.success) {
    return temporaryRedirect(failed);
  }

  const auth = await getAuthSession();
  try {
    await auth.verifyEmailToken({ tokenHash: parsed.data.token_hash, type: parsed.data.type });
  } catch (error) {
    if (isTypedError(error, InvalidTokenError)) {
      return temporaryRedirect(failed);
    }
    throw error;
  }
  return temporaryRedirect(safeNextPath(parsed.data.next));
}
