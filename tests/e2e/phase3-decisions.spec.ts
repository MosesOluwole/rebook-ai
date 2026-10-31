import { type Page } from '@playwright/test';

import { expect, test } from './helpers/fixtures';

import { expectNoHorizontalScroll, onboard, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Test-engineer additions (Phase 3 decisions), at desktop and 375 px:
 *
 * - item 3: the weekly hours editor goes up to the domain maximum of breaks as well as ranges,
 *   removes rows, and a save never drops a stored row it did not remove;
 * - item 1 through the browser: a non-health business is offered client fields; switching it to
 *   midwife is refused in settings while a client field exists, works once it is deleted, and the
 *   Custom fields page then offers services only.
 */

const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page, name: string) => form(page, name).getByRole('status');
const errorBanner = (page: Page) => page.locator('p.notice.error');

async function newBusiness(page: Page, type: 'Midwife' | 'Event planner'): Promise<string> {
  await signUp(page, uniqueEmail('p3d'));
  return onboard(page, `Phase Three Decisions ${Date.now().toString(36)}`, type);
}

const label = (base: 'Hours' | 'Break', index: number) =>
  index === 0 ? base : `${base} ${String(index + 1)}`;

async function expectPairs(
  day: ReturnType<Page['getByRole']>,
  base: 'Hours' | 'Break',
  pairs: readonly (readonly [string, string])[],
) {
  for (const [index, [from, to]] of pairs.entries()) {
    await expect(day.getByLabel(`${label(base, index)} from`)).toHaveValue(from);
    await expect(day.getByLabel(`${label(base, index)} to`)).toHaveValue(to);
  }
  await expect(day.getByLabel(`${label(base, pairs.length)} from`)).toHaveCount(0);
}

test('the hours editor reaches four breaks, removes rows, and keeps every stored row it did not remove', async ({
  page,
}) => {
  const slug = await newBusiness(page, 'Event planner');
  await page.goto(`/app/${slug}/team`);
  await page.getByRole('region', { name: 'Team members' }).getByRole('link').first().click();

  const monday = page.getByRole('group', { name: 'Monday' });
  const ranges = [
    ['07:00', '08:00'],
    ['09:00', '12:00'],
    ['13:00', '17:00'],
    ['18:00', '24:00'],
  ] as const;
  const breaks = [
    ['09:30', '09:45'],
    ['10:30', '10:45'],
    ['14:00', '14:15'],
    ['19:00', '19:15'],
  ] as const;
  for (const [index, [from, to]] of ranges.entries()) {
    if (index > 0) {
      await monday.getByRole('button', { name: 'Add hours on Monday' }).click();
    }
    await monday.getByLabel(`${label('Hours', index)} from`).fill(from);
    await monday.getByLabel(`${label('Hours', index)} to`).fill(to);
  }
  for (const [index, [from, to]] of breaks.entries()) {
    if (index > 0) {
      await monday.getByRole('button', { name: 'Add a break on Monday' }).click();
    }
    await monday.getByLabel(`${label('Break', index)} from`).fill(from);
    await monday.getByLabel(`${label('Break', index)} to`).fill(to);
  }
  // The domain maximum is four of each: no button offers a fifth.
  await expect(monday.getByRole('button', { name: 'Add hours on Monday' })).toHaveCount(0);
  await expect(monday.getByRole('button', { name: 'Add a break on Monday' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(saved(page, 'Weekly hours')).toHaveText('Working hours saved.');

  await page.reload();
  await expectPairs(page.getByRole('group', { name: 'Monday' }), 'Hours', ranges);
  await expectPairs(page.getByRole('group', { name: 'Monday' }), 'Break', breaks);
  await expectNoHorizontalScroll(page);

  // Remove the first range (it holds no break) and the second break; save; reload.
  const before = page.getByRole('group', { name: 'Monday' });
  await before.getByRole('button', { name: 'Remove hours', exact: true }).click();
  await before.getByRole('button', { name: 'Remove break 2', exact: true }).click();
  await expect(before.getByRole('button', { name: 'Add hours on Monday' })).toHaveCount(1);
  await expect(before.getByRole('button', { name: 'Add a break on Monday' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(saved(page, 'Weekly hours')).toHaveText('Working hours saved.');
  expect(new URL(page.url()).search).toBe('');

  await page.reload();
  const after = page.getByRole('group', { name: 'Monday' });
  await expectPairs(after, 'Hours', ranges.slice(1));
  await expectPairs(after, 'Break', [breaks[0], breaks[2], breaks[3]]);
  await expectNoHorizontalScroll(page);
});

test('a planner with a client field cannot become a midwife business until the field is deleted', async ({
  page,
}) => {
  const slug = await newBusiness(page, 'Event planner');

  await page.goto(`/app/${slug}/custom-fields`);
  const newField = form(page, 'New field');
  const scope = newField.getByRole('combobox', { name: 'For', exact: true });
  await expect(scope.getByRole('option')).toHaveCount(2);
  await scope.selectOption('client');
  await newField.getByRole('textbox', { name: 'Label', exact: true }).fill('Guest count');
  await newField.getByLabel('Key (lowercase, used in exports)').fill('guest_count');
  await newField.getByRole('combobox', { name: 'Type', exact: true }).selectOption('number');
  await newField.getByRole('button', { name: 'Add field' }).click();
  await expect(saved(page, 'New field')).toHaveText('Custom field added.');

  await page.goto(`/app/${slug}/settings`);
  await page.getByRole('radio', { name: 'Midwife' }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(errorBanner(page)).toHaveText(
    'A business with client custom fields, or free-text fields without the health override, cannot become a health business. Delete those fields on the Custom fields page first.',
  );
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Event planner' })).toBeChecked();
  await expectNoHorizontalScroll(page);

  await page.goto(`/app/${slug}/custom-fields`);
  await page.getByRole('button', { name: 'Delete Guest count' }).click();
  await expect(page.getByText('No custom fields yet.')).toBeVisible();

  await page.goto(`/app/${slug}/settings`);
  await page.getByRole('radio', { name: 'Midwife' }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(form(page, 'Business settings').getByRole('status')).toHaveText('Settings saved.');

  await page.goto(`/app/${slug}/custom-fields`);
  await expect(
    form(page, 'New field').getByRole('combobox', { name: 'For', exact: true }).getByRole('option'),
  ).toHaveText(['services']);
  await expectNoHorizontalScroll(page);
});
