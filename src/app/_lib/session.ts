import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import {
  type AuthenticatedUser,
  type AuthGateway,
  createAuthSession,
  type UserActor,
} from '@/modules/tenancy';
import { type SessionCookies } from '@/shared/auth/supabase';

import { safeNextPath } from './safe-next';

/**
 * Request-scoped identity for server components, server actions and route handlers. The user is
 * verified with Supabase on every request (docs/adr/ADR-004-auth-sessions.md); the proxy only
 * refreshes the session and short-circuits obviously signed-out requests.
 */

/** Adapts Next's request cookie store to the shape the Supabase client needs. */
export async function nextSessionCookies(): Promise<SessionCookies> {
  const store = await cookies();
  return {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (toSet) => {
      // Server components cannot write cookies (the response has started); the proxy persists
      // refreshed tokens on their behalf, so swallowing the write here is the documented pattern.
      try {
        for (const { name, value, options } of toSet) {
          store.set(name, value, {
            domain: options.domain,
            expires: options.expires,
            httpOnly: options.httpOnly,
            maxAge: options.maxAge,
            path: options.path,
            sameSite: options.sameSite,
            secure: options.secure,
          });
        }
      } catch (error) {
        // Only the render-time write is expected; anything else must surface. The text is
        // Next 16.4.3's ("Cookies can only be modified in a Server Action or Route Handler");
        // re-check it on every Next upgrade (docs/setup.md, troubleshooting).
        if (!(error instanceof Error && /Cookies can only be modified/i.test(error.message))) {
          throw error;
        }
      }
    },
  };
}

export async function getAuthSession(): Promise<AuthGateway> {
  return createAuthSession(await nextSessionCookies());
}

/** The signed-in user, verified once per request, or null. */
export const currentUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const auth = await getAuthSession();
  return auth.currentUser();
});

/** One request id per request, so every audit entry of the request shares it. */
export const currentRequestId = cache((): string => randomUUID());

export function actorFor(user: AuthenticatedUser): UserActor {
  return { user, requestId: currentRequestId() };
}

/** The signed-in user, or a redirect to sign-in that returns here afterwards. */
export async function requireUser(returnTo: string): Promise<AuthenticatedUser> {
  const user = await currentUser();
  if (user === null) {
    redirect(`/sign-in?next=${encodeURIComponent(safeNextPath(returnTo))}`);
  }
  return user;
}
