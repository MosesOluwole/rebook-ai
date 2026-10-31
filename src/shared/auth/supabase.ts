import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { type SupabaseClient } from '@supabase/supabase-js';

import { getEnv } from '@/shared/config/env';

/**
 * The only place a Supabase client is created (docs/adr/ADR-004-auth-sessions.md). It is a
 * server-side client authenticated with the publishable key; the session lives in HTTP-only
 * cookies that the caller supplies through `getAll`/`setAll`, so the same factory serves the
 * request interceptor (which can write cookies) and server components (which cannot). No
 * browser client exists: the browser never learns the Supabase URL or any key.
 */

export const SESSION_COOKIE_NAME = 'rebook-session';

/** Cookie access for one request. Both methods are required so token refreshes are persisted. */
export type SessionCookies = Required<Pick<CookieMethodsServer, 'getAll' | 'setAll'>>;

/**
 * Only the Auth API is exposed. The Data API half of the client is deliberately unreachable:
 * every table read and write goes through `withTenant` (docs/adr/ADR-002), never PostgREST.
 */
export type SupabaseAuthOnlyClient = Pick<SupabaseClient, 'auth'>;

export function createSupabaseServerClient(cookies: SessionCookies): SupabaseAuthOnlyClient {
  const env = getEnv();
  const client = createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies,
    cookieOptions: {
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
    },
  });
  return { auth: client.auth };
}
