import { type NextRequest, NextResponse } from 'next/server';

/**
 * The site's origin as the browser sees it. In Next's Node server `request.nextUrl` is built
 * from the listen hostname, so behind a reverse proxy it says `localhost`; the browser's view
 * comes from the proxy's `x-forwarded-host`/`x-forwarded-proto`, or from `host` when the app is
 * reached directly (local dev, CI). This is the same source Next's own server-action origin
 * check uses (docs/adr/ADR-004 §9).
 */
export function siteOrigin(request: NextRequest): string {
  // A blank forwarded host (a misconfigured proxy) falls back to Host rather than failing every
  // post; a missing or unusable host falls back to the listen address, which fails closed.
  const host =
    firstValue(request.headers.get('x-forwarded-host')) ?? firstValue(request.headers.get('host'));
  const proto =
    firstValue(request.headers.get('x-forwarded-proto')) ??
    request.nextUrl.protocol.replace(/:$/, '');
  if (host === undefined) {
    return request.nextUrl.origin;
  }
  try {
    // Normalised like the browser's Origin: lower-case host, default port dropped (`:443`).
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return request.nextUrl.origin;
  }
}

function firstValue(header: string | null): string | undefined {
  const first = header?.split(',')[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}

/**
 * A relative Location that is safe to put in a header: percent-encoded (header values must be
 * Latin-1), with any `//host` prefix collapsed so the redirect can never leave this site.
 */
function relativeLocation(path: string): string {
  const url = new URL(path, 'http://n');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A form POST answered with a redirect the browser follows as GET. Path-relative: no host is guessed. */
export function seeOther(path: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location: relativeLocation(path), 'cache-control': 'no-store' },
  });
}

/** A GET answered with a temporary redirect, path-relative like `seeOther`. */
export function temporaryRedirect(path: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { location: relativeLocation(path), 'cache-control': 'no-store' },
  });
}

/** Redirects back to a form with a message and the preserved `next` target. */
export function backToForm(path: string, params: Readonly<Record<string, string>>): NextResponse {
  const query = new URLSearchParams(params);
  return seeOther(`${path}?${query.toString()}`);
}

/**
 * Route handlers that accept form posts are not protected by React's server-action origin check,
 * so they check it themselves: the Origin header (or, failing that, the Referer) must be this
 * site as the browser sees it. Browsers always send one of the two on a form POST.
 */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin') ?? refererOrigin(request.headers.get('referer'));
  if (origin !== siteOrigin(request)) {
    return new NextResponse('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  return null;
}

function refererOrigin(referer: string | null): string | null {
  if (referer === null) {
    return null;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** 429 with the generic message and a Retry-After. The same body for every key and scope. */
export function tooManyRequests(retryAfterSeconds: number, backTo: string): NextResponse {
  const body = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many attempts</title></head><body style="font-family:system-ui;padding:1.5rem;max-width:40rem"><h1>Too many attempts</h1><p>Try again in a few minutes.</p><p><a href="${escapeHtml(backTo)}">Back</a></p></body></html>`;
  return new NextResponse(body, {
    status: 429,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(retryAfterSeconds),
    },
  });
}
