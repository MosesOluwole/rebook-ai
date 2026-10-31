import { type Page } from '@playwright/test';

import { expect, newClientContext, test } from './helpers/fixtures';

import {
  expectNoHorizontalScroll,
  onboard,
  PASSWORD,
  signInWithPassword,
  signUp,
  uniqueEmail,
} from './helpers/accounts';

/**
 * Phase 2 acceptance criteria that auth-journey.spec.ts and access.spec.ts do not pin down
 * directly, at desktop and 375 px:
 *
 * - a user who abandons onboarding returns to it at the NEXT SIGN-IN (not just on navigation);
 * - a member asking for another tenant's slug gets the same 404 as an unknown slug on every
 *   workspace route (dashboard, team, settings), with an identical body;
 * - a staff member's screens expose no owner-only action;
 * - every phase screen fits the viewport with its actions reachable (sign-in, sign-up,
 *   onboarding, invite landing, 404).
 */

async function expectSamePageAs(page: Page, pathA: string, pathB: string, status: number) {
  const a = await page.goto(pathA);
  expect(a?.status(), pathA).toBe(status);
  const bodyA = await page.locator('main').innerText();
  const b = await page.goto(pathB);
  expect(b?.status(), pathB).toBe(status);
  const bodyB = await page.locator('main').innerText();
  expect(bodyA).toBe(bodyB);
  expect(bodyA).toContain('Not found');
  return bodyA;
}

test('abandoned onboarding resumes at the next sign-in, and nothing was created meanwhile', async ({
  page,
  context,
}) => {
  const email = uniqueEmail('resume');
  await signUp(page, email);
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Walk away: the session ends (browser closed), nothing was submitted.
  await context.clearCookies();
  const signedOut = await page.goto('/app');
  expect(signedOut?.status()).toBe(200);
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);

  // Next sign-in lands straight back on onboarding.
  await signInWithPassword(page, email);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { user: { email: string }; tenants: unknown[] };
  expect(body.tenants).toEqual([]);
  expect(body.user.email).toBe(email);

  // /app keeps sending a tenant-less user to onboarding; a bare slug is a 404, not an error page.
  await page.goto('/app');
  await expect(page).toHaveURL(/\/onboarding$/);
  const notMine = await page.goto('/app/nobody-has-this-slug');
  expect(notMine?.status()).toBe(404);
  await expectNoHorizontalScroll(page);
});

test('another tenant slug is the same 404 as an unknown slug on dashboard, team and settings', async ({
  browser,
  page,
}) => {
  // Tenant X belongs to user X.
  await signUp(page, uniqueEmail('tenant-x'));
  const slugX = await onboard(page, 'Isolated Practice', 'Midwife');

  // User Y has their own tenant and asks for X's by slug.
  const contextY = await newClientContext(browser, { viewport: page.viewportSize() });
  const y = await contextY.newPage();
  await signUp(y, uniqueEmail('tenant-y'));
  const slugY = await onboard(y, 'Other Studio', 'Event planner');
  expect(slugY).not.toBe(slugX);

  const unknown = `${slugX}-does-not-exist`;
  const dashboard = await expectSamePageAs(y, `/app/${slugX}`, `/app/${unknown}`, 404);
  const team = await expectSamePageAs(y, `/app/${slugX}/team`, `/app/${unknown}/team`, 404);
  const settings = await expectSamePageAs(
    y,
    `/app/${slugX}/settings`,
    `/app/${unknown}/settings`,
    404,
  );
  expect(team).toBe(dashboard);
  expect(settings).toBe(dashboard);
  await expectNoHorizontalScroll(y);

  // Y's own workspace still works, and the switcher lists only Y's business.
  await y.goto(`/app/${slugY}`);
  await expect(y.getByRole('heading', { level: 1, name: 'Other Studio' })).toBeVisible();
  const switcher = y.getByRole('navigation', { name: 'Switch business' });
  await expect(switcher.getByRole('link', { name: 'Other Studio' })).toBeVisible();
  await expect(switcher.getByRole('link', { name: 'Isolated Practice' })).toHaveCount(0);

  // The API lists only Y's tenants as well.
  const me = (await (await y.request.get('/api/me')).json()) as { tenants: { slug: string }[] };
  expect(me.tenants.map((tenant) => tenant.slug)).toEqual([slugY]);
  await contextY.close();
});

test('a staff member sees no owner-only action on team or settings', async ({ browser, page }) => {
  const staffEmail = uniqueEmail('staff-ro');
  await signUp(page, uniqueEmail('owner-ro'));
  const slug = await onboard(page, 'Read Only Events', 'Event planner');
  await page.goto(`/app/${slug}/team`);
  await page.getByLabel('Email').fill(staffEmail);
  await page.getByLabel('Role').selectOption('staff');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = (await page.getByTestId('invite-link').textContent()) ?? '';
  expect(link).toMatch(new RegExp(`/invite/${slug}/[A-Za-z0-9_-]{43}$`));

  const staffContext = await newClientContext(browser, { viewport: page.viewportSize() });
  const staff = await staffContext.newPage();
  await staff.goto(link);
  await expect(staff).toHaveURL(/\/sign-in\?next=%2Finvite/);
  await expectNoHorizontalScroll(staff);
  await staff.getByRole('link', { name: 'Create an account' }).click();
  await expect(staff).toHaveURL(/\/sign-up\?next=%2Finvite/);
  await expectNoHorizontalScroll(staff);
  await staff.getByLabel('Email').fill(staffEmail);
  await staff.getByLabel('Password').fill(PASSWORD);
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
  await expectNoHorizontalScroll(staff);
  await expect(staff.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  await staff.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(staff).toHaveURL(new RegExp(`/app/${slug}$`));

  // Settings: read-only, no save, no flag toggles, the explanation shown.
  await staff.goto(`/app/${slug}/settings`);
  await expect(staff.getByText('Only an owner can change these settings.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: /^Turn (on|off)$/ })).toHaveCount(0);
  await expect(staff.getByRole('textbox', { name: 'Name' })).toBeDisabled();
  await expect(staff.getByTestId('flag-ai_chat')).toHaveText('off');
  await expectNoHorizontalScroll(staff);

  // Team: can see members, cannot invite or remove.
  await staff.goto(`/app/${slug}/team`);
  await expect(staff.getByRole('region', { name: 'Members' }).getByRole('row')).toHaveCount(3);
  await expect(staff.getByText('Only an owner can invite or remove team members.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Create invite link' })).toHaveCount(0);
  await expectNoHorizontalScroll(staff);

  // The used link, revisited, is still a plain 200 landing page and accepting again is a no-op.
  await staff.goto(link);
  await staff.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(staff).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(staff.getByText('you are an staff')).toBeVisible();
  await staffContext.close();

  // Owner's view: the flag is still off; the invitation is gone from the open list.
  await page.goto(`/app/${slug}/settings`);
  await expect(page.getByTestId('flag-ai_chat')).toHaveText('off');
  await page.goto(`/app/${slug}/team`);
  await expect(page.getByRole('region', { name: 'Open invitations' })).toContainText('None');
});

test('sign-in rejects a wrong password without leaking which part was wrong and keeps next', async ({
  page,
}) => {
  const email = uniqueEmail('wrongpw');
  await signUp(page, email);
  await page.context().clearCookies();

  await page.goto('/sign-in?next=%2Fapp%2Fsomewhere%2Fteam');
  await expectNoHorizontalScroll(page);
  const form = page.getByRole('region', { name: 'With your password' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill('definitely-not-the-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in\?error=/);
  await expect(page.locator('p[role="alert"]')).toHaveText('Incorrect email or password');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/app/somewhere/team');
  await expectNoHorizontalScroll(page);

  // An unknown address gets the identical message.
  await form.getByLabel('Email').fill(uniqueEmail('nobody'));
  await form.getByLabel('Password').fill('definitely-not-the-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('Incorrect email or password');
});

test('signed-out settings and an off-site next are handled safely', async ({ page }) => {
  const response = await page.goto('/app/some-business/settings');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/app/some-business/settings');

  // A crafted next must never leave the site: it is replaced by /app, which lands on onboarding.
  const email = uniqueEmail('open-redirect');
  await page.goto('/sign-up?next=https%3A%2F%2Fevil.example%2Fphish');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/onboarding$/);
});
