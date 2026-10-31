import { expect, test } from './helpers/fixtures';

import { onboard, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Phase 2 follow-ups (origin hardening, ADR-004 §9): the app's origin is the configured
 * APP_ORIGIN, never Host or X-Forwarded-*. The gate's server runs with APP_ORIGIN equal to
 * Playwright's baseURL (playwright.config.ts). Spoofed headers are sent by the client here, as an
 * attacker reaching the server would send them; the server is real.
 */

const SPOOFED = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
const FORM_ROUTES = [
  { path: '/auth/password', form: { password: 'wrong-password-here' } },
  { path: '/auth/magic-link', form: {} },
  { path: '/auth/sign-up', form: { password: 'short' } },
] as const;

test('a POST with a foreign Origin gets 403 on every form route, whatever the forwarded headers say', async ({
  request,
  baseURL,
}) => {
  for (const route of FORM_ROUTES) {
    const form = { email: uniqueEmail('foreign'), next: '/app', ...route.form };
    const foreign = await request.post(route.path, {
      form,
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    });
    expect(foreign.status(), route.path).toBe(403);

    // Spoofing the forwarded host to match the foreign Origin changes nothing.
    const spoofed = await request.post(route.path, {
      form,
      headers: { ...SPOOFED, origin: 'https://evil.example' },
      maxRedirects: 0,
    });
    expect(spoofed.status(), `${route.path} spoofed`).toBe(403);

    // A same-site Referer does not rescue a foreign Origin: Referer counts only without Origin.
    const withReferer = await request.post(route.path, {
      form,
      headers: { origin: 'https://evil.example', referer: `${baseURL ?? ''}/sign-in` },
      maxRedirects: 0,
    });
    expect(withReferer.status(), `${route.path} referer`).toBe(403);
  }
});

test('a POST from APP_ORIGIN is accepted even when the forwarded headers name another host', async ({
  request,
  baseURL,
}) => {
  const accepted = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('app-origin'), next: '/app' },
    headers: { ...SPOOFED, origin: baseURL ?? '' },
    maxRedirects: 0,
  });
  // Accepted: the plain-post answer is the "check your email" page (no redirect, no URL message).
  expect(accepted.status()).toBe(200);
  expect(await accepted.text()).toContain('Check your email for a sign-in link');
});

test('every form-post redirect carries a path-relative Location', async ({ request, baseURL }) => {
  // A successful sign-up redirects (relative) to onboarding; a failure is a page, not a redirect.
  const signUp = await request.post('/auth/sign-up', {
    form: { email: uniqueEmail('relative'), password: 'correct-horse-battery', next: '/app' },
    headers: { ...SPOOFED, origin: baseURL ?? '' },
    maxRedirects: 0,
  });
  expect(signUp.status()).toBe(303);
  expect(signUp.headers().location).toBe('/onboarding');

  const signIn = await request.post('/auth/password', {
    form: { email: uniqueEmail('relative'), password: 'wrong-password-here', next: '/app' },
    headers: { ...SPOOFED, origin: baseURL ?? '' },
    maxRedirects: 0,
  });
  expect(signIn.status()).toBe(401);
  expect(signIn.headers().location).toBeUndefined();

  const bogus = await request.get('/auth/confirm', {
    params: { token_hash: 'not-a-real-token-hash-value', type: 'magiclink', next: '/app' },
    headers: SPOOFED,
    maxRedirects: 0,
  });
  expect(bogus.status()).toBe(307);
  // A code the sign-in page turns into its own sentence; no message text in the URL.
  expect(bogus.headers().location).toBe('/sign-in?link=invalid');
});

/** The interceptor's Location: absolute on APP_ORIGIN, or relativised by Next (same origin). */
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

test('the signed-out redirect from the request interceptor stays on APP_ORIGIN with spoofed host headers', async ({
  request,
  baseURL,
}) => {
  const spoofed = await request.get('/app/some-business/team?tab=1', {
    headers: { ...SPOOFED, host: 'evil.example' },
    maxRedirects: 0,
  });
  expect(spoofed.status()).toBe(307);
  const target = redirectTarget(spoofed.headers().location);
  expect(target.pathAndQuery).toBe(
    `/sign-in?next=${encodeURIComponent('/app/some-business/team?tab=1')}`,
  );
  expect([null, baseURL ?? '']).toContain(target.origin);
  expect(spoofed.headers().location).not.toContain('evil.example');

  // API routes stay 401 JSON, no redirect, whatever the headers say.
  const api = await request.get('/api/me', { headers: SPOOFED, maxRedirects: 0 });
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ error: 'unauthenticated' });
});

test('a server action with spoofed X-Forwarded-Host and matching Origin is refused by the proxy', async ({
  page,
}) => {
  await signUp(page, uniqueEmail('spoof-owner'));
  const slug = await onboard(page, 'Spoof Proof Events', 'Event planner');

  // From here every request claims to be for evil.example, and the Origin agrees, so Next's own
  // server-action check (Origin host against X-Forwarded-Host) would let the action run: the case
  // where a header-derived link would point at the attacker's host. Since Phase 3 the request
  // interceptor compares Origin with APP_ORIGIN first and refuses the POST with 403 (ADR-004 §9),
  // so the action never runs. Chromium refuses to override Host itself; a spoofed Host is covered
  // through the request API in invite-link-spoofed-host.spec.ts. This keeps the real browser path
  // (JavaScript server action, no React internals) under a spoofed X-Forwarded-Host.
  await page.setExtraHTTPHeaders({ ...SPOOFED, origin: 'https://evil.example' });
  await page.goto(`/app/${slug}/team`);
  await page.getByLabel('Email').fill(uniqueEmail('spoof-invitee'));
  await page.getByLabel('Role').selectOption('staff');
  const [action] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/app/${slug}/team`,
    ),
    page.getByRole('button', { name: 'Create invite link' }).click(),
  ]);
  expect(action.status()).toBe(403);
  await expect(page.getByTestId('invite-link')).toHaveCount(0);

  // Without the spoofed headers the owner sees that nothing was created.
  await page.setExtraHTTPHeaders({});
  await page.goto(`/app/${slug}/team`);
  await expect(
    page.getByRole('region', { name: 'Open invitations' }).getByText('None.'),
  ).toBeVisible();
});
