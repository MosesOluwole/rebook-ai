import { type NextRequest, NextResponse } from 'next/server';

import { type Env, getEnv } from '@/shared/config/env';

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

/** Whether the caller is the form component (src/app/_components/forms.tsx, RouteForm). */
export function wantsJson(request: NextRequest): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json');
}

/**
 * The answer of an auth route handler. The form component asks for JSON and gets the outcome as
 * data (its status code is the real one: 200, 400, 401); a no-JavaScript form post gets a 303 to
 * `redirect`, or a small HTML page with the message and a link back. Messages never travel in a
 * URL (CLAUDE.md, "Forms"); they are ours, never the submitted input.
 */
export function routeAnswer(
  request: NextRequest,
  answer:
    | { readonly redirect: string }
    | {
        readonly ok: boolean;
        readonly status: number;
        readonly message: string;
        readonly backTo: string;
      },
): NextResponse {
  if ('redirect' in answer) {
    return wantsJson(request)
      ? NextResponse.json(
          { ok: true, redirect: relativeLocation(answer.redirect) },
          { headers: { 'cache-control': 'no-store' } },
        )
      : seeOther(answer.redirect);
  }
  if (wantsJson(request)) {
    return NextResponse.json(
      { ok: answer.ok, message: answer.message },
      { status: answer.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return messagePage(answer.status, answer.ok ? 'Done' : 'Not done', answer.message, answer.backTo);
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/**
 * The origins a same-site form post may come from: APP_ORIGIN, and in development only, when
 * APP_ORIGIN is itself a loopback address, the same scheme and port on the other loopback names
 * (a developer may open http://127.0.0.1:3000 as readily as http://localhost:3000). Nothing here
 * is read from the request (docs/adr/ADR-004 §9).
 */
export function allowedOrigins(env: Pick<Env, 'APP_ORIGIN' | 'NODE_ENV'>): ReadonlySet<string> {
  const origins = new Set([env.APP_ORIGIN]);
  const app = new URL(env.APP_ORIGIN);
  if (
    env.NODE_ENV === 'development' &&
    (LOOPBACK_HOSTS as readonly string[]).includes(app.hostname)
  ) {
    for (const host of LOOPBACK_HOSTS) {
      const variant = new URL(env.APP_ORIGIN);
      variant.hostname = host;
      origins.add(variant.origin);
    }
  }
  return origins;
}

/**
 * Route handlers that accept form posts are not protected by React's server-action origin check,
 * so they check it themselves: the Origin header must be one of `allowedOrigins`. The Referer is
 * consulted only when Origin is absent; a post with neither, or with `Origin: null`, is refused.
 */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const header = request.headers.get('origin');
  const origin = header === null ? originOf(request.headers.get('referer')) : originOf(header);
  if (origin === null || !allowedOrigins(getEnv()).has(origin)) {
    return new NextResponse('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  return null;
}

/** The serialised origin of a URL-valued header, or null when absent, opaque or malformed. */
function originOf(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A minimal HTML page for no-JavaScript form posts: a heading, our message and a link back. */
function messagePage(
  status: number,
  title: string,
  message: string,
  backTo: string,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  const body = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui;padding:1.5rem;max-width:40rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(backTo)}">Back</a></p></body></html>`;
  return new NextResponse(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

const TOO_MANY = 'Too many attempts. Try again in a few minutes.';

/** 429 with the generic message and a Retry-After. The same body for every key and scope. */
export function tooManyRequests(
  retryAfterSeconds: number,
  backTo: string,
  json = false,
): NextResponse {
  const headers = { 'cache-control': 'no-store', 'retry-after': String(retryAfterSeconds) };
  if (json) {
    return NextResponse.json({ ok: false, message: TOO_MANY }, { status: 429, headers });
  }
  return messagePage(429, 'Too many attempts', 'Try again in a few minutes.', backTo, {
    'retry-after': String(retryAfterSeconds),
  });
}
