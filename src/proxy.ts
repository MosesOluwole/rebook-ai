import { type NextRequest, NextResponse } from 'next/server';

import { createAuthSession } from '@/modules/tenancy';

import { siteOrigin } from './app/_lib/http';

/**
 * Request interceptor (docs/adr/ADR-004-auth-sessions.md). Runs on the Node.js runtime before
 * every matched request:
 *
 * 1. Refreshes the Supabase session when the access token is about to expire and writes the new
 *    cookies to both the forwarded request and the response.
 * 2. Verifies the user. Signed-out requests to the back office redirect to sign-in with a return
 *    path; signed-out API requests get 401 JSON. Pages verify again themselves: this is a short
 *    circuit, never the only check.
 */

const PROTECTED_PAGE_PREFIXES = ['/app', '/onboarding', '/invite'];

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const auth = createAuthSession({
    getAll: () => request.cookies.getAll(),
    setAll: (toSet) => {
      for (const { name, value } of toSet) {
        request.cookies.set(name, value);
      }
      response = NextResponse.next({ request });
      for (const { name, value, options } of toSet) {
        response.cookies.set(name, value, {
          domain: options.domain,
          expires: options.expires,
          httpOnly: options.httpOnly,
          maxAge: options.maxAge,
          path: options.path,
          sameSite: options.sameSite,
          secure: options.secure,
        });
      }
    },
  });

  const user = await auth.currentUser();
  const { pathname, search } = request.nextUrl;

  if (user === null) {
    // Every /api route is for signed-in users; /health is not under /api and stays public.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (PROTECTED_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      // The proxy layer insists on an absolute Location. It is built from the origin the browser
      // used (forwarded host and proto, or Host), never from `request.nextUrl`, which carries the
      // server's listen address behind a reverse proxy (ADR-004 §9).
      const signIn = new URL(
        `/sign-in?next=${encodeURIComponent(`${pathname}${search}`)}`,
        siteOrigin(request),
      );
      // The host comes from forwarded headers, so the response must never be cached for others.
      return NextResponse.redirect(signIn, { headers: { 'cache-control': 'no-store' } });
    }
  }

  return response;
}

export const config = {
  // Everything except Next's own assets and static files. /health stays reachable for probes.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)',
  ],
};
