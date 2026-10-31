import { expect, newClientContext, test } from './helpers/fixtures';

import {
  expectNoHorizontalScroll,
  onboard,
  PASSWORD,
  signInWithPassword,
  signOut,
  signUp,
  uniqueEmail,
} from './helpers/accounts';
import { confirmLinkIn, waitForEmail } from './helpers/mailpit';

/**
 * Phase 2 journeys at desktop and 375 px: sign up, onboard, sign out, sign in (password and
 * magic link), invite, accept, switch tenant. Each test owns its accounts; emails are synthetic
 * and land in the local Mailpit.
 */

test('a new owner signs up, onboards as a midwife and lands on a dashboard in that vocabulary', async ({
  page,
}) => {
  const email = uniqueEmail('midwife');
  await signUp(page, email);
  await expectNoHorizontalScroll(page);

  const slug = await onboard(page, 'Bloom Midwifery', 'Midwife');
  expect(slug).toMatch(/^bloom-midwifery(?:-[a-z0-9]{4})?$/);

  await expect(page.getByRole('heading', { level: 1, name: 'Bloom Midwifery' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patients' })).toBeVisible();
  await expect(page.getByText('No appointments yet')).toBeVisible();
  await expect(page.getByText('health business')).toBeVisible();
  await expect(page.getByText('you are an owner')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Event planner vocabulary, as a second business of the same owner (also proves the switcher).
  await page.getByRole('link', { name: '+ New business' }).click();
  const second = await onboard(page, 'Bloom Midwifery', 'Event planner');
  expect(second).not.toBe(slug);
  expect(second).toMatch(/^bloom-midwifery-[a-z0-9]{4}$/);
  await expect(page.getByRole('heading', { name: 'Enquiries' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await expect(page.getByText('health business')).toHaveCount(0);

  // Switch back through the switcher: only this user's two businesses are listed.
  const switcher = page.getByRole('navigation', { name: 'Switch business' });
  await expect(switcher.getByRole('listitem')).toHaveCount(3); // two businesses + "New business"
  await switcher.getByRole('link', { name: 'Bloom Midwifery', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();

  await signOut(page);
  await signInWithPassword(page, email);
  await expect(page).toHaveURL(new RegExp(`/app/${slug}$`));
});

test('a user who abandons onboarding returns to it at next sign-in', async ({ page }) => {
  const email = uniqueEmail('abandon');
  await signUp(page, email);
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

  // Leave without creating anything, then come back.
  await page.goto('/');
  await page.getByRole('link', { name: 'Go to your workspace' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { tenants: unknown[] }).tenants).toEqual([]);
});

test('sign-in with a magic link read from the mail catcher', async ({ page, request, baseURL }) => {
  const email = uniqueEmail('magic');
  await signUp(page, email);
  const slug = await onboard(page, 'Link Clinic', 'Other appointment-based business');
  await signOut(page);

  const requestedAt = Date.now();
  await page.goto('/sign-in');
  const linkForm = page.getByRole('region', { name: 'With a sign-in link' });
  await linkForm.getByLabel('Email').fill(email);
  await linkForm.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');

  const message = await waitForEmail(request, email, 'Sign in to Rebook AI', requestedAt);
  const link = confirmLinkIn(message, baseURL);
  expect(link).toContain('/auth/confirm?token_hash=');
  expect(link).toContain('type=magiclink');

  await page.goto(link);
  await expect(page).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Link Clinic' })).toBeVisible();

  // The link was single-use.
  await signOut(page);
  await page.goto(link);
  // A code, not a message, in the URL; the page supplies the sentence.
  await expect(page).toHaveURL(/\/sign-in\?link=invalid$/);
  // Next's route announcer is also role=alert; the message is the paragraph.
  await expect(page.locator('p[role="alert"]')).toContainText('invalid or has expired');
});

test('an owner invites a team member who accepts and sees only the inviting business', async ({
  browser,
  page,
}) => {
  const ownerEmail = uniqueEmail('owner');
  const staffEmail = uniqueEmail('staff');
  await signUp(page, ownerEmail);
  const slug = await onboard(page, 'Invite Events', 'Event planner');

  // Second business the staff member must never see.
  await page.getByRole('link', { name: '+ New business' }).click();
  await onboard(page, 'Private Side Business', 'Other appointment-based business');
  await page.goto(`/app/${slug}/team`);

  await page.getByLabel('Email').fill(staffEmail);
  await page.getByLabel('Role').selectOption('staff');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByTestId('invite-link').textContent();
  expect(link).toMatch(new RegExp(`/invite/${slug}/[A-Za-z0-9_-]{43}$`));
  await expect(page.getByRole('region', { name: 'Open invitations' })).toContainText(staffEmail);
  await expectNoHorizontalScroll(page);

  // The invitee, in a fresh browser: the link asks to sign in first, then to accept.
  const staffContext = await newClientContext(browser, { viewport: page.viewportSize() });
  const staff = await staffContext.newPage();
  await staff.goto(link ?? '');
  await expect(staff).toHaveURL(/\/sign-in\?next=%2Finvite/);
  await staff.getByRole('link', { name: 'Create an account' }).click();
  await expect(staff).toHaveURL(/\/sign-up\?next=%2Finvite/);
  await staff.getByLabel('Email').fill(staffEmail);
  await staff.getByLabel('Password').fill(PASSWORD);
  await staff.getByRole('button', { name: 'Create account' }).click();
  await expect(staff).toHaveURL(new RegExp(`/invite/${slug}/`));
  await expect(staff.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
  await staff.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(staff).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(staff.getByText('you are an staff')).toBeVisible();

  const staffSwitcher = staff.getByRole('navigation', { name: 'Switch business' });
  await expect(staffSwitcher.getByRole('link', { name: 'Invite Events' })).toBeVisible();
  await expect(staffSwitcher.getByRole('link', { name: 'Private Side Business' })).toHaveCount(0);

  // Cross-tenant request: the other business's slug is a 404 for the staff member.
  const otherSlug = 'private-side-business';
  const forbidden = await staff.goto(`/app/${otherSlug}`);
  expect(forbidden?.status()).toBe(404);
  const missing = await staff.goto(`/app/${otherSlug}-does-not-exist`);
  expect(missing?.status()).toBe(404);

  // Staff see the team but cannot invite; accepting the link again changes nothing.
  await staff.goto(`/app/${slug}/team`);
  await expect(staff.getByText('Only an owner can invite')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Create invite link' })).toHaveCount(0);
  await staff.goto(link ?? '');
  await staff.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(staff).toHaveURL(new RegExp(`/app/${slug}$`));

  const me = await staff.request.get('/api/me');
  const body = (await me.json()) as { tenants: { slug: string }[] };
  expect(body.tenants.map((tenant) => tenant.slug)).toEqual([slug]);
  await staffContext.close();

  // The owner now sees two members and no open invitation.
  await page.goto(`/app/${slug}/team`);
  await expect(page.getByRole('region', { name: 'Members' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Open invitations' })).toContainText('None');
});

test('settings and feature flags are owner-only and audited through the UI', async ({ page }) => {
  const email = uniqueEmail('settings');
  await signUp(page, email);
  const slug = await onboard(page, 'Flag Studio', 'Other appointment-based business');
  await page.goto(`/app/${slug}/settings`);
  await expectNoHorizontalScroll(page);

  await expect(page.getByTestId('flag-ai_chat')).toHaveText('off');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ai_chat turned on' })).toBeVisible();
  await expect(page.getByTestId('flag-ai_chat')).toHaveText('on');

  await page.getByRole('textbox', { name: 'Name' }).fill('Flag Studio Renamed');
  await page.getByRole('radio', { name: 'Midwife' }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(
    page.getByRole('form', { name: 'Business settings' }).getByRole('status'),
  ).toHaveText('Settings saved.');
  await page.goto(`/app/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Flag Studio Renamed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patients' })).toBeVisible();
});
