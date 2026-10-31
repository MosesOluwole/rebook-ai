import { expect, test } from './helpers/fixtures';

import { uniqueEmail } from './helpers/accounts';

/**
 * B1 (code review): the site's origin is taken from the proxy's forwarded headers (or Host),
 * never from the server's listen address, and redirects are path-relative. No proxy can sit in
 * front of the test server, so the proxy's headers are sent by the client here; the server is
 * real. Each test has its own client IP (helpers/fixtures.ts), so nothing here hits a limit.
 */

const PROXIED = { 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' };

test('a form post that arrived through a proxy is judged by the forwarded site, not the listen address', async ({
  request,
  baseURL,
}) => {
  // The browser behind the proxy says Origin https://app.example: accepted, redirect is relative.
  const accepted = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('proxied-ok'), next: '/app' },
    headers: { ...PROXIED, origin: 'https://app.example' },
    maxRedirects: 0,
  });
  expect(accepted.status()).toBe(303);
  expect(accepted.headers().location).toMatch(/^\/sign-in\?sent=1/);

  // The same post with the listen address as Origin is cross-site from the browser's view.
  const listenAddress = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('proxied-listen'), next: '/app' },
    headers: { ...PROXIED, origin: baseURL ?? '' },
    maxRedirects: 0,
  });
  expect(listenAddress.status()).toBe(403);

  // Forwarded host without forwarded proto makes the site http://app.example: an https Origin is refused.
  const noProto = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('proxied-noproto'), next: '/app' },
    headers: { 'x-forwarded-host': 'app.example', origin: 'https://app.example' },
    maxRedirects: 0,
  });
  expect(noProto.status()).toBe(403);
});

test('every form-post redirect carries a path-relative Location', async ({ request }) => {
  const signIn = await request.post('/auth/password', {
    form: { email: uniqueEmail('relative'), password: 'wrong-password-here', next: '/app' },
    headers: { ...PROXIED, origin: 'https://app.example' },
    maxRedirects: 0,
  });
  expect(signIn.status()).toBe(303);
  expect(signIn.headers().location).toMatch(/^\/sign-in\?error=/);
  expect(signIn.headers().location).not.toContain('localhost');
  expect(signIn.headers().location).not.toContain('app.example');

  const signUp = await request.post('/auth/sign-up', {
    form: { email: uniqueEmail('relative-su'), password: 'short', next: '/app' },
    headers: { ...PROXIED, origin: 'https://app.example' },
    maxRedirects: 0,
  });
  expect(signUp.status()).toBe(303);
  expect(signUp.headers().location).toMatch(/^\/sign-up\?error=/);
});

test('the email-link landing route redirects path-relatively on a bad or missing token', async ({
  request,
}) => {
  const missing = await request.get('/auth/confirm', { maxRedirects: 0 });
  expect(missing.status()).toBe(307);
  expect(missing.headers().location).toMatch(/^\/sign-in\?error=/);

  const bogus = await request.get('/auth/confirm', {
    params: { token_hash: 'not-a-real-token-hash-value', type: 'magiclink', next: '/app' },
    headers: PROXIED,
    maxRedirects: 0,
  });
  expect(bogus.status()).toBe(307);
  expect(bogus.headers().location).toMatch(/^\/sign-in\?error=/);
  expect(bogus.headers().location).not.toContain('localhost');
});

/**
 * The interceptor builds an absolute URL (its layer refuses relative ones); Next then relativises
 * a same-origin Location on the way out. Either form is right for a browser; what must never
 * appear is the server's listen address when the request came through a proxy.
 */
function redirectTarget(location: string | undefined): {
  origin: string | null;
  pathAndQuery: string;
} {
  const url = new URL(location ?? '', 'https://relative.invalid');
  return {
    origin: url.origin === 'https://relative.invalid' ? null : url.origin,
    pathAndQuery: `${url.pathname}${url.search}`,
  };
}

test('the signed-out redirect from the request interceptor never points at the listen address', async ({
  request,
  baseURL,
}) => {
  // Reached directly: relative, or absolute on the Host the client used.
  const direct = await request.get('/app/some-business/team?tab=1', { maxRedirects: 0 });
  expect(direct.status()).toBe(307);
  const directTarget = redirectTarget(direct.headers().location);
  expect(directTarget.pathAndQuery).toBe(
    `/sign-in?next=${encodeURIComponent('/app/some-business/team?tab=1')}`,
  );
  expect([null, baseURL ?? '']).toContain(directTarget.origin);

  // Behind a proxy: relative, or absolute on the forwarded host and proto; never localhost.
  const proxied = await request.get('/onboarding', { headers: PROXIED, maxRedirects: 0 });
  expect(proxied.status()).toBe(307);
  const proxiedTarget = redirectTarget(proxied.headers().location);
  expect(proxiedTarget.pathAndQuery).toBe('/sign-in?next=%2Fonboarding');
  expect([null, 'https://app.example']).toContain(proxiedTarget.origin);
  expect(proxied.headers().location).not.toContain('localhost');

  // API routes stay 401 JSON, no redirect, whatever the headers say.
  const api = await request.get('/api/me', { headers: PROXIED, maxRedirects: 0 });
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ error: 'unauthenticated' });
});
