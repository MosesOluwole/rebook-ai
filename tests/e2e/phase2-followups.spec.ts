import { type Page } from '@playwright/test';

import { expect, newClientContext, test } from './helpers/fixtures';

import {
  expectNoHorizontalScroll,
  onboard,
  PASSWORD,
  signUp,
  uniqueEmail,
} from './helpers/accounts';

/**
 * Phase 2 follow-ups through the browser, at desktop and 375 px:
 *
 * 2. a midwife business cannot be changed to a non-health type from Settings (clear message, type
 *    unchanged); non-health types change freely and into midwife;
 * 3. a second open invitation for one address is refused on the Team page; an active member who
 *    accepts another invitation is told they already belong and keeps their role.
 */

type BusinessLabel = 'Event planner' | 'Midwife' | 'Other appointment-based business';

/**
 * Submits the settings form and waits for the server action's own response, so the next step
 * never races the re-render (every successful save redirects to the same URL, which makes
 * "Settings saved" and a just-clicked radio useless as a wait signal on their own).
 */
async function saveSettings(page: Page, slug: string): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/app/${slug}/settings`,
    ),
    page.getByRole('button', { name: 'Save settings' }).click(),
  ]);
}

/** The stored type as the server renders it: the dashboard label line and the settings radio. */
async function expectStoredType(page: Page, slug: string, label: BusinessLabel): Promise<void> {
  await page.goto(`/app/${slug}`);
  await expect(page.getByText(new RegExp(`^${label} · `))).toBeVisible();
  await page.goto(`/app/${slug}/settings`);
  await expect(page.getByRole('radio', { name: label })).toBeChecked();
}

test('settings refuse midwife → non-health with a clear message and keep the type; other edits save', async ({
  page,
}) => {
  await signUp(page, uniqueEmail('health'));
  const slug = await onboard(page, 'Harbour Midwives', 'Midwife');

  for (const target of ['Event planner', 'Other appointment-based business'] as const) {
    await page.goto(`/app/${slug}/settings`);
    await expect(page.getByRole('radio', { name: 'Midwife' })).toBeChecked();
    await page.getByRole('radio', { name: target }).check();
    await saveSettings(page, slug);
    await expect(page.locator('p[role="alert"]')).toContainText(
      'A midwife business cannot be changed to another business type',
    );
    await expectNoHorizontalScroll(page);
    await expectStoredType(page, slug, 'Midwife');
  }

  // The dashboard still speaks the health vocabulary.
  await page.goto(`/app/${slug}`);
  await expect(page.getByRole('heading', { name: 'Patients' })).toBeVisible();

  // Name and time zone still change while the type stays midwife.
  await page.goto(`/app/${slug}/settings`);
  await page.getByRole('textbox', { name: 'Name' }).fill('Harbour Midwives Ltd');
  await page.getByLabel('Time zone').selectOption('Europe/Dublin');
  await saveSettings(page, slug);
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.goto(`/app/${slug}/settings`);
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Harbour Midwives Ltd');
  await expect(page.getByRole('radio', { name: 'Midwife' })).toBeChecked();
  await expect(page.getByLabel('Time zone')).toHaveValue('Europe/Dublin');
  await page.goto(`/app/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Harbour Midwives Ltd' })).toBeVisible();
  await expect(page.getByText(/^Midwife · Europe\/Dublin · /)).toBeVisible();
});

test('non-health types change in every direction and into midwife, after which the way back is closed', async ({
  page,
}) => {
  await signUp(page, uniqueEmail('planner'));
  const slug = await onboard(page, 'Lantern Events', 'Event planner');

  for (const target of ['Other appointment-based business', 'Event planner', 'Midwife'] as const) {
    await page.goto(`/app/${slug}/settings`);
    await page.getByRole('radio', { name: target }).check();
    await saveSettings(page, slug);
    await expect(page.getByRole('status')).toContainText('Settings saved');
    await expectStoredType(page, slug, target);
  }

  await page.goto(`/app/${slug}/settings`);
  await page.getByRole('radio', { name: 'Event planner' }).check();
  await saveSettings(page, slug);
  await expect(page.locator('p[role="alert"]')).toContainText(
    'A midwife business cannot be changed',
  );
  await expectStoredType(page, slug, 'Midwife');
});

test('a duplicate open invitation is refused; an active member accepting a second one is told so and keeps their role', async ({
  browser,
  page,
}) => {
  const memberEmail = uniqueEmail('member');
  await signUp(page, uniqueEmail('owner2'));
  const slug = await onboard(page, 'Second Invite Events', 'Event planner');
  await page.goto(`/app/${slug}/team`);

  // First invitation (staff).
  await page.getByLabel('Email').fill(memberEmail);
  await page.getByLabel('Role').selectOption('staff');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const firstLink = await page.getByTestId('invite-link').textContent();
  expect(firstLink).toMatch(new RegExp(`/invite/${slug}/[A-Za-z0-9_-]{43}$`));

  // A second one for the same address, in another case, is refused while the first is open.
  await page.getByLabel('Email').fill(memberEmail.toUpperCase());
  await page.getByLabel('Role').selectOption('owner');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText(
    'An invitation for this email address is already open',
  );
  await expectNoHorizontalScroll(page);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Open invitations' }).getByText(memberEmail),
  ).toHaveCount(1);

  // The member accepts the first invitation in their own browser.
  const memberContext = await newClientContext(browser, { viewport: page.viewportSize() });
  const member = await memberContext.newPage();
  await member.goto(firstLink ?? '');
  await expect(member).toHaveURL(/\/sign-in\?next=%2Finvite/);
  await member.getByRole('link', { name: 'Create an account' }).click();
  await expect(member).toHaveURL(/\/sign-up\?next=%2Finvite/);
  await member.getByLabel('Email').fill(memberEmail);
  await member.getByLabel('Password').fill(PASSWORD);
  await member.getByRole('button', { name: 'Create account' }).click();
  await expect(member).toHaveURL(new RegExp(`/invite/${slug}/`));
  await member.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(member).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(member.getByText('you are an staff')).toBeVisible();

  // The first invitation is closed, so the owner can create another (as owner this time).
  await page.goto(`/app/${slug}/team`);
  await page.getByLabel('Email').fill(memberEmail);
  await page.getByLabel('Role').selectOption('owner');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const secondLink = await page.getByTestId('invite-link').textContent();
  expect(secondLink).toMatch(new RegExp(`/invite/${slug}/[A-Za-z0-9_-]{43}$`));
  expect(secondLink).not.toBe(firstLink);

  // Accepting it as an active member changes nothing: told so, role still staff, invite still open.
  await member.goto(secondLink ?? '');
  await member.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(member.getByRole('status')).toContainText(
    'You are already a member of this business',
  );
  // Told as form state: the address is still the plain invite link.
  await expect(member).toHaveURL(new RegExp(`/invite/${slug}/[A-Za-z0-9_-]{43}$`));
  await expectNoHorizontalScroll(member);
  await member.getByRole('link', { name: 'Open the business' }).click();
  await expect(member).toHaveURL(new RegExp(`/app/${slug}$`));
  await expect(member.getByText('you are an staff')).toBeVisible();

  const me = await member.request.get('/api/me');
  const body = (await me.json()) as { tenants: { slug: string; role: string }[] };
  expect(body.tenants).toEqual([expect.objectContaining({ slug, role: 'staff' })]);
  await memberContext.close();

  await page.goto(`/app/${slug}/team`);
  await expect(page.getByRole('region', { name: 'Open invitations' })).toContainText(memberEmail);
  await expect(page.getByRole('region', { name: 'Members' }).getByRole('row')).toHaveCount(3);
});
