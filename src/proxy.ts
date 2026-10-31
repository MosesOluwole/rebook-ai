import { type NextRequest, NextResponse } from 'next/server';

import { rejectCrossOrigin } from '@/app/_lib/http';
import { createAuthSession } from '@/modules/tenancy';
import { appUrl } from '@/shared/config/app-url';

/**
 * Request interceptor (docs/adr/ADR-004-auth-sessions.md). Runs on the Node.js runtime before
 * every matched request:
 *
 * 0. Refuses every cross-origin request that is not a GET or HEAD with 403, using the same
 *    APP_ORIGIN allow-list as the form route handlers (`rejectCrossOrigin`). Server actions are
 *    POSTs to page paths, so this check covers them without relying on Next's own origin check,
 *    which compares against the Host and X-Forwarded-Host headers (ADR-004 §9).
 * 1. Refreshes the Supabase session when the access token is about to expire and writes the new
 *    cookies to both the forwarded request and the response.
 * 2. Verifies the user. Signed-out requests to the back office redirect to sign-in with a return
 *    path; signed-out API requests get 401 JSON. Pages verify again themselves: this is a short
 *    circuit, never the only check.
 */

const PROTECTED_PAGE_PREFIXES = ['/app', '/onboarding', '/invite'];

/** Methods without side effects. HEAD is a GET without a body, so it is safe in the same way. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Reads that need no session: Next's image optimiser, the favicon, the health probe and files by
 * extension. Exempt for GET and HEAD only: a dynamic segment also matches `/app/x/services/a.png`,
 * so a POST there must still meet the origin gate (it could carry a no-JavaScript server action).
 */
const SESSIONLESS_READ =
  /^\/(?:_next\/image|favicon\.ico$|health(?:\/|$))|\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$/;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!SAFE_METHODS.has(request.method)) {
    const refused = rejectCrossOrigin(request);
    if (refused !== null) {
      return refused;
    }
  } else if (SESSIONLESS_READ.test(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

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
    // Only page loads are redirected. A signed-out POST (a server action, or the invite-accept
    // route) answers for itself: actions call requireUser, and the route answers JSON to the form
    // component, which a redirect here would turn into an HTML page it cannot read.
    if (
      SAFE_METHODS.has(request.method) &&
      PROTECTED_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ) {
      // The proxy layer insists on an absolute Location. It is built on the configured
      // APP_ORIGIN, never on Host, X-Forwarded-* or `request.nextUrl` (ADR-004 §9).
      const signIn = appUrl(`/sign-in?next=${encodeURIComponent(`${pathname}${search}`)}`);
      return NextResponse.redirect(signIn, { headers: { 'cache-control': 'no-store' } });
    }
  }

  return response;
}

export const config = {
  // Everything except Next's build output: every non-GET request meets the origin gate, whatever
  // its path. Sessionless reads (assets, /health) are let through inside `proxy`.
  matcher: ['/((?!_next/static).*)'],
};
