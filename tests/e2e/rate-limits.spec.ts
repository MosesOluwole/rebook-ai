import { expect, freshIp, test } from './helpers/fixtures';

import { PASSWORD, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Phase 2 follow-up: fixed-window rate limits on sign-in, sign-up, magic link and invite
 * acceptance, keyed on client IP and on normalised email, answered with 429 and one generic
 * message. The limits are AUTH_RATE_LIMITS in src/modules/platform/domain/rate-limit.ts:
 * sign_in 5 per address, magic_link 10 per IP within the window.
 */

test('the sixth wrong password for one address is refused with 429, even from new IPs', async ({
  browser,
  baseURL,
}) => {
  const address = uniqueEmail('locked');
  const origin = baseURL ?? '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': freshIp(), origin },
    });
    const response = await context.request.post('/auth/password', {
      form: { email: address.toUpperCase(), password: 'wrong-password-here', next: '/app' },
      maxRedirects: 0,
    });
    if (attempt <= 5) {
      expect(response.status(), `attempt ${attempt}`).toBe(303);
      expect(response.headers().location).toContain('/sign-in?error=');
    } else {
      expect(response.status()).toBe(429);
      expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
      expect(await response.text()).toContain('Too many attempts');
      expect(await response.text()).not.toContain(address);
    }
    await context.close();
  }
});

test('the eleventh sign-in link request from one IP is refused with 429, whatever the address', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': freshIp(), origin: baseURL ?? '' },
  });
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const response = await context.request.post('/auth/magic-link', {
      form: { email: uniqueEmail(`ip${attempt}`), next: '/app' },
      maxRedirects: 0,
    });
    if (attempt <= 10) {
      expect(response.status(), `attempt ${attempt}`).toBe(303);
    } else {
      expect(response.status()).toBe(429);
    }
  }
  await context.close();
});

test('the refusal renders as a page when it comes from the sign-in form', async ({ browser }) => {
  const address = uniqueEmail('form');
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': freshIp() } });
  const page = await context.newPage();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await page.goto('/sign-in');
    const form = page.getByRole('region', { name: 'With your password' });
    await form.getByLabel('Email').fill(address);
    await form.getByLabel('Password').fill('not-the-password');
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/auth/password') && r.request().method() === 'POST',
      ),
      form.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    if (attempt === 6) {
      expect(response.status()).toBe(429);
      await expect(page.getByRole('heading', { name: 'Too many attempts' })).toBeVisible();
    } else {
      await expect(page.locator('p[role="alert"]')).toContainText('Incorrect email or password');
    }
  }
  await context.close();
});

test('a correct password is also refused once the address is over the limit', async ({
  browser,
  page,
}) => {
  const address = uniqueEmail('real');
  await signUp(page, address);
  await page.getByRole('button', { name: 'Sign out' }).click();

  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': freshIp() } });
  const origin = new URL(page.url()).origin;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await context.request.post('/auth/password', {
      form: { email: address, password: 'wrong-password-here', next: '/app' },
      headers: { origin },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
  }
  const refused = await context.request.post('/auth/password', {
    form: { email: address, password: PASSWORD, next: '/app' },
    headers: { origin },
    maxRedirects: 0,
  });
  expect(refused.status()).toBe(429);
  await context.close();
});

test('form posts without a same-origin Origin or Referer are refused with 403', async ({
  request,
}) => {
  for (const path of ['/auth/password', '/auth/magic-link', '/auth/sign-up']) {
    const response = await request.post(path, {
      form: { email: uniqueEmail('csrf'), password: PASSWORD, next: '/app' },
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(403);
  }
});

// ---- Follow-up verification (test engineer) -------------------------------------------------

test('the fourth sign-up attempt for one address within the hour is refused with 429, and nothing is created', async ({
  browser,
  baseURL,
}) => {
  // sign_up: 3 per address per hour. A too-short password keeps every attempt from reaching the
  // auth provider, so the limiter is what is measured and no account is created.
  const address = uniqueEmail('signup-limit');
  const origin = baseURL ?? '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': freshIp(), origin },
    });
    const response = await context.request.post('/auth/sign-up', {
      form: { email: ` ${address.toUpperCase()} `, password: 'short', next: '/app' },
      maxRedirects: 0,
    });
    if (attempt <= 3) {
      expect(response.status(), `attempt ${attempt}`).toBe(303);
      expect(response.headers().location).toContain('/sign-up?error=');
    } else {
      expect(response.status()).toBe(429);
      const retryAfter = Number(response.headers()['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      const body = await response.text();
      expect(body).toContain('Too many attempts');
      expect(body.toLowerCase()).not.toContain(address.toLowerCase());
    }
    await context.close();
  }
});

test('the eleventh invitation acceptance by one signed-in user is refused with 429', async ({
  page,
}) => {
  // invite_accept: 10 per address. A well-formed token for an unknown business is a 404 each
  // time (no oracle); the limiter runs before that check and answers the eleventh with 429.
  await signUp(page, uniqueEmail('accept-limit'));
  const origin = new URL(page.url()).origin;
  const token = 'A'.repeat(43);
  // Signed in, but from another site: refused before anything is counted or checked.
  const crossSite = await page.request.post(`/invite/no-such-business/${token}/accept`, {
    headers: { origin: 'https://evil.example' },
    maxRedirects: 0,
  });
  expect(crossSite.status()).toBe(403);
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const response = await page.request.post(`/invite/no-such-business/${token}/accept`, {
      headers: { origin },
      maxRedirects: 0,
    });
    expect(response.status(), `attempt ${attempt}`).toBe(attempt <= 10 ? 404 : 429);
  }
});

test('a same-site Referer is enough for a form post; neither Origin nor Referer is refused with 403', async ({
  request,
  baseURL,
}) => {
  const origin = baseURL ?? '';
  const withReferer = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('referer'), next: '/app' },
    headers: { referer: `${origin}/sign-in` },
    maxRedirects: 0,
  });
  expect(withReferer.status()).toBe(303);

  const bare = await request.post('/auth/magic-link', {
    form: { email: uniqueEmail('bare'), next: '/app' },
    headers: { origin: '', referer: '' },
    maxRedirects: 0,
  });
  expect(bare.status()).toBe(403);

  // Signed out, the accept route is never reached: the proxy sends the request to sign-in first.
  const signedOut = await request.post(`/invite/no-such-business/${'B'.repeat(43)}/accept`, {
    headers: { origin: 'https://evil.example' },
    maxRedirects: 0,
  });
  expect(signedOut.status()).toBe(307);
  expect(signedOut.headers().location).toContain('/sign-in?next=');
});

test('the refusal page fits the viewport and leads back to sign-in', async ({ browser, page }) => {
  // Same viewport as the running project (desktop or 375 px), a fresh client IP of its own.
  const address = uniqueEmail('page429');
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    extraHTTPHeaders: { 'x-forwarded-for': freshIp() },
  });
  const origin = new URL(
    page.url() === 'about:blank' ? ((await page.goto('/sign-in'))?.url() ?? '') : page.url(),
  ).origin;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await context.request.post('/auth/password', {
      form: { email: address, password: 'wrong-password-here', next: '/app' },
      headers: { origin },
      maxRedirects: 0,
    });
    expect(response.status(), `attempt ${attempt}`).toBe(303);
  }
  const refused = await context.newPage();
  await refused.goto('/sign-in');
  const form = refused.getByRole('region', { name: 'With your password' });
  await form.getByLabel('Email').fill(address);
  await form.getByLabel('Password').fill('wrong-password-here');
  const [response] = await Promise.all([
    refused.waitForResponse(
      (r) => r.url().endsWith('/auth/password') && r.request().method() === 'POST',
    ),
    form.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  expect(response.status()).toBe(429);
  await expect(refused.getByRole('heading', { name: 'Too many attempts' })).toBeVisible();
  await expect(refused.getByText('Try again in a few minutes.')).toBeVisible();
  const overflow = await refused.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await refused.getByRole('link', { name: 'Back' }).click();
  await expect(refused).toHaveURL(/\/sign-in$/);
  await context.close();
});
