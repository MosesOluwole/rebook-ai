import { expect, type Page } from '@playwright/test';

/** Synthetic accounts; the local stack sends every email to Mailpit, nothing leaves the machine. */
export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
}

export const PASSWORD = 'correct-horse-battery';

export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Local config does not require confirmation, so sign-up lands on onboarding.
  await expect(page).toHaveURL(/\/onboarding$/);
}

export async function signInWithPassword(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  const form = page.getByRole('region', { name: 'With your password' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

export async function onboard(
  page: Page,
  name: string,
  businessType: 'Midwife' | 'Event planner' | 'Other appointment-based business',
): Promise<string> {
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Business name').fill(name);
  await page.getByRole('radio', { name: new RegExp(`^${businessType}`) }).check();
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/app\/[a-z0-9-]+$/);
  const slug = /\/app\/([a-z0-9-]+)$/.exec(page.url())?.[1];
  if (slug === undefined) {
    throw new Error(`no slug in ${page.url()}`);
  }
  return slug;
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
