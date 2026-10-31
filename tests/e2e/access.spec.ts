import { expect, newClientContext, test } from './helpers/fixtures';

/**
 * Phase 2 acceptance criterion: signed-out access to back-office routes redirects to sign-in;
 * API routes return 401; a forged or expired session cookie is rejected.
 */

/** A syntactically valid Supabase session cookie whose access token was signed by nobody. */
const FORGED_SESSION = Buffer.from(
  JSON.stringify({
    access_token:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(
        JSON.stringify({
          sub: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f',
          email: 'forger@example.invalid',
          role: 'authenticated',
          aud: 'authenticated',
          exp: 4_102_444_800,
          iat: 1_700_000_000,
        }),
      ).toString('base64url') +
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    refresh_token: 'forged-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: { id: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f' },
  }),
).toString('base64url');

/** The same shape, but expired years ago. */
const EXPIRED_SESSION = Buffer.from(
  JSON.stringify({
    access_token:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(
        JSON.stringify({
          sub: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f',
          role: 'authenticated',
          aud: 'authenticated',
          exp: 1_600_000_000,
          iat: 1_599_996_400,
        }),
      ).toString('base64url') +
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    refresh_token: 'expired-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1_600_000_000,
    user: { id: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f' },
  }),
).toString('base64url');

test.describe('signed out', () => {
  for (const path of [
    '/app',
    '/app/some-business',
    '/app/some-business/team',
    '/onboarding',
    '/invite/some-business/' + 'a'.repeat(43),
  ]) {
    test(`${path} redirects to sign-in and returns there afterwards`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      expect(new URL(page.url()).searchParams.get('next')).toBe(path);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
  }

  test('API routes answer 401 JSON', async ({ request }) => {
    const response = await request.get('/api/me');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('the health probe stays public', async ({ request }) => {
    expect((await request.get('/health')).status()).toBe(200);
  });
});

test.describe('bad session cookies', () => {
  for (const [label, value] of [
    ['forged', FORGED_SESSION],
    ['expired', EXPIRED_SESSION],
    ['garbage', 'not-a-session-at-all'],
  ] as const) {
    test(`a ${label} cookie is treated as signed out on pages and APIs`, async ({ browser }) => {
      const context = await newClientContext(browser);
      await context.addCookies([
        { name: 'rebook-session', value: `base64-${value}`, domain: 'localhost', path: '/' },
      ]);
      const page = await context.newPage();
      await page.goto('/app/some-business');
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      const api = await context.request.get('/api/me');
      expect(api.status()).toBe(401);
      await context.close();
    });
  }
});
