import { expect, test } from '@playwright/test';

test('home page renders and fits the viewport', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Rebook AI' })).toBeVisible();

  // No horizontal scroll at any project viewport (desktop and 375 px).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('link', { name: 'Health check' }).click();
  await expect(page).toHaveURL(/\/health$/);
});
