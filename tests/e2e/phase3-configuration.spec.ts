import { type Page } from '@playwright/test';

import { expect, newClientContext, test } from './helpers/fixtures';

import { expectNoHorizontalScroll, onboard, signUp, uniqueEmail } from './helpers/accounts';

/** Our error banner; Next's route announcer also carries role="alert". */
const errorBanner = (page: Page) => page.locator('p.notice.error');

/**
 * Phase 3 through the browser, at desktop and 375 px (docs/phases.md Phase 3):
 *
 * - create a service, add a team member, set hours, add time off, define a custom field;
 * - invalid configuration shows field-level errors from the server;
 * - a health business needs the explicit override for a free-text field;
 * - the business type is locked once a service exists;
 * - another tenant's service id in a URL is a 404;
 * - a server-action POST with a foreign Origin is refused by the proxy (Phase 2 follow-up).
 */

async function newBusiness(page: Page, type: 'Midwife' | 'Event planner'): Promise<string> {
  await signUp(page, uniqueEmail('p3'));
  return onboard(page, `Phase Three ${type} ${Date.now().toString(36)}`, type);
}

async function createService(page: Page, slug: string, name: string): Promise<string> {
  await page.goto(`/app/${slug}/services`);
  const form = page.getByRole('region', { name: 'New service' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Duration (minutes)').fill('45');
  await form.getByLabel('Buffer after (minutes)').fill('15');
  await form.getByLabel('Price').fill('60.50');
  await form.getByRole('button', { name: 'Create service' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${slug}/services/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const id = /services\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id === undefined) {
    throw new Error('no service id in the URL');
  }
  return id;
}

/** A form by its accessible name (ActionForm's label), and the outcome banner inside it. */
const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page, name: string) => form(page, name).getByRole('status');

/** Outcomes travel as form state: the address stays clean whatever happens. */
function expectCleanUrl(page: Page): void {
  expect(new URL(page.url()).search).toBe('');
}

test('a midwife configures a service, a team member, hours, time off and custom fields', async ({
  page,
}) => {
  const slug = await newBusiness(page, 'Midwife');

  // Field-level errors come back from the server as form state, next to their inputs, with what
  // was typed still in place. The browser's own min/max checks are switched off so the server's
  // validation is what is under test.
  await page.goto(`/app/${slug}/services`);
  const newService = form(page, 'New service');
  await newService.evaluate((element) => {
    (element as HTMLFormElement).noValidate = true;
  });
  await newService.getByLabel('Name').fill('Antenatal check');
  await newService.getByLabel('Duration (minutes)').fill('45');
  await newService.getByLabel('Buffer before (minutes)').fill('300');
  await newService.getByLabel('Price').fill('10.999');
  await newService.getByLabel('Currency (e.g. GBP)').fill('XYZ');
  await newService.getByRole('button', { name: 'Create service' }).click();
  await expect(errorBanner(page)).toHaveText('Check the highlighted fields.');
  await expect(newService.getByLabel('Price')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('at most 2 decimal places')).toBeVisible();
  await expect(page.getByText('must be between 0 and 240 minutes')).toBeVisible();
  await expect(page.getByText('an ISO 4217 currency code in current use')).toBeVisible();
  await expect(newService.getByLabel('Name')).toHaveValue('Antenatal check');
  await expect(newService.getByLabel('Price')).toHaveValue('10.999');
  await expect(newService.getByLabel('Buffer before (minutes)')).toHaveValue('300');
  expectCleanUrl(page);
  await expectNoHorizontalScroll(page);

  // Correct the two fields and submit the same form: it creates the service.
  await newService.getByLabel('Buffer before (minutes)').fill('0');
  await newService.getByLabel('Price').fill('60.50');
  await newService.getByLabel('Currency (e.g. GBP)').fill('GBP');
  await newService.getByRole('button', { name: 'Create service' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Antenatal check' })).toBeVisible();
  await expect(page.getByTestId('service-status')).toHaveText('Unpublished');
  await expect(page.getByLabel('Booking mode')).toHaveValue('timed');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('service-status')).toHaveText('Published');
  await expectNoHorizontalScroll(page);

  // Onboarding made the owner the first team member, linked to their sign-in.
  await page.goto(`/app/${slug}/team`);
  const teamList = page.getByRole('region', { name: 'Team members' });
  await expect(teamList.getByRole('listitem')).toHaveCount(1);
  await expect(teamList.getByRole('listitem')).toContainText('signs in');

  // Add a second team member who does not sign in, and make them eligible for the service.
  await page.getByLabel('Display name').fill('Midwife Ada');
  await page.getByRole('button', { name: 'Add team member' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Midwife Ada' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('checkbox', { name: 'Antenatal check' }).check();
  await page.getByRole('button', { name: 'Save services' }).click();
  await expect(saved(page, 'Eligible services')).toHaveText('Services saved.');
  await expect(page.getByRole('checkbox', { name: 'Antenatal check' })).toBeChecked();

  // Set hours: Monday 09:00–17:00 with lunch; an overlapping Tuesday is refused per field, and
  // everything typed stays on screen.
  const monday = page.getByRole('group', { name: 'Monday' });
  await monday.getByLabel('Hours from').fill('09:00');
  await monday.getByLabel('Hours to').fill('17:00');
  await monday.getByLabel('Break from').fill('12:30');
  await monday.getByLabel('Break to').fill('13:15');
  const tuesday = page.getByRole('group', { name: 'Tuesday' });
  await tuesday.getByLabel('Hours from').fill('09:00');
  await tuesday.getByLabel('Hours to').fill('13:00');
  await tuesday.getByRole('button', { name: 'Add hours on Tuesday' }).click();
  await tuesday.getByLabel('Hours 2 from').fill('12:00');
  await tuesday.getByLabel('Hours 2 to').fill('17:00');
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(page.getByText('overlaps another working range on Tuesday')).toBeVisible();
  await expect(tuesday.getByLabel('Hours 2 from')).toHaveAttribute('aria-invalid', 'true');
  await expect(monday.getByLabel('Break to')).toHaveValue('13:15');
  await expect(tuesday.getByLabel('Hours 2 to')).toHaveValue('17:00');
  expectCleanUrl(page);

  await tuesday.getByRole('button', { name: 'Remove hours' }).nth(1).click();
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(saved(page, 'Weekly hours')).toHaveText('Working hours saved.');
  await expect(monday.getByLabel('Hours from')).toHaveValue('09:00');
  await expect(monday.getByLabel('Hours to')).toHaveValue('17:00');
  await expect(monday.getByLabel('Break from')).toHaveValue('12:30');
  await expect(tuesday.getByLabel('Hours to')).toHaveValue('13:00');
  await expect(tuesday.getByLabel('Hours 2 from')).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Add time off, in the location's local time.
  const timeOff = form(page, 'Add time off');
  await timeOff.getByLabel('From', { exact: true }).fill('2030-12-24T09:00');
  await timeOff.getByLabel('Until', { exact: true }).fill('2030-12-27T17:00');
  await timeOff.getByRole('button', { name: 'Add time off' }).click();
  await expect(saved(page, 'Add time off')).toHaveText('Time off added.');
  await expect(page.getByRole('list', { name: 'Upcoming time off' })).toContainText(
    '24 Dec 2030, 09:00 – 27 Dec 2030, 17:00',
  );

  // Home visits are offered to midwives: districts are normalised.
  await page.getByLabel('Postcode districts (e.g. SW1A, N1; no full postcodes)').fill('sw1a, n1');
  await page.getByLabel('Travel before (minutes)').fill('20');
  await page.getByRole('button', { name: 'Save home visits' }).click();
  await expect(saved(page, 'Home visits')).toHaveText('Service areas saved.');
  await expect(
    page.getByLabel('Postcode districts (e.g. SW1A, N1; no full postcodes)'),
  ).toHaveValue('N1, SW1A');

  // Custom fields: no client-scoped fields for a health business; a free-text service field is
  // refused without the override, then accepted with it.
  await page.goto(`/app/${slug}/custom-fields`);
  await expect(page.getByRole('note')).toContainText('custom fields are for services only');
  const newField = form(page, 'New field');
  const scope = newField.getByRole('combobox', { name: 'For', exact: true });
  await expect(scope.getByRole('option')).toHaveText(['services']);
  await newField.getByRole('textbox', { name: 'Label', exact: true }).fill('Access notes');
  await newField.getByLabel('Key (lowercase, used in exports)').fill('access_notes');
  await newField.getByRole('combobox', { name: 'Type', exact: true }).selectOption('long_text');
  await newField.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText(/free-text fields are off for health businesses/)).toBeVisible();
  await expect(newField.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue(
    'Access notes',
  );
  expectCleanUrl(page);
  await expectNoHorizontalScroll(page);

  await newField.getByRole('checkbox', { name: /Override: allow this free-text field/ }).check();
  await newField.getByRole('button', { name: 'Add field' }).click();
  await expect(saved(page, 'New field')).toHaveText('Custom field added.');
  await expect(page.getByText('Free text enabled by override')).toBeVisible();

  // A list field for services, then a value on the service.
  await newField.getByRole('textbox', { name: 'Label', exact: true }).fill('Room');
  await newField.getByLabel('Key (lowercase, used in exports)').fill('room');
  await newField.getByRole('combobox', { name: 'Type', exact: true }).selectOption('select');
  await newField.getByLabel('Options (list types only, one per line)').fill('Blue\nGreen');
  await newField.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('Room', { exact: true })).toBeVisible();

  await page.goto(`/app/${slug}/services`);
  await page.getByRole('link', { name: 'Antenatal check' }).click();
  await page.getByLabel('Room').selectOption('Green');
  await page.getByRole('button', { name: 'Save custom fields' }).click();
  await expect(saved(page, 'Custom field values')).toHaveText('Custom fields saved.');
  await expect(page.getByLabel('Room')).toHaveValue('Green');
  await expectNoHorizontalScroll(page);
});

test('a day with four working ranges survives saving another day unchanged', async ({ page }) => {
  const slug = await newBusiness(page, 'Event planner');
  await page.goto(`/app/${slug}/team`);
  await page.getByRole('region', { name: 'Team members' }).getByRole('link').first().click();

  // Seed Monday with the maximum: four ranges (and two breaks), saved through the form.
  const monday = page.getByRole('group', { name: 'Monday' });
  const ranges = [
    ['07:00', '08:00'],
    ['09:00', '12:00'],
    ['13:00', '17:00'],
    ['18:00', '24:00'],
  ] as const;
  for (const [index, [from, to]] of ranges.entries()) {
    const label = index === 0 ? 'Hours' : `Hours ${String(index + 1)}`;
    if (index > 0) {
      await monday.getByRole('button', { name: 'Add hours on Monday' }).click();
    }
    await monday.getByLabel(`${label} from`).fill(from);
    await monday.getByLabel(`${label} to`).fill(to);
  }
  await expect(monday.getByRole('button', { name: 'Add hours on Monday' })).toHaveCount(0);
  await monday.getByLabel('Break from').fill('10:00');
  await monday.getByLabel('Break to').fill('10:15');
  await monday.getByRole('button', { name: 'Add a break on Monday' }).click();
  await monday.getByLabel('Break 2 from').fill('14:00');
  await monday.getByLabel('Break 2 to').fill('14:15');
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(saved(page, 'Weekly hours')).toHaveText('Working hours saved.');

  // A fresh load renders every stored row.
  await page.reload();
  const reloaded = page.getByRole('group', { name: 'Monday' });
  for (const [index, [from, to]] of ranges.entries()) {
    const label = index === 0 ? 'Hours' : `Hours ${String(index + 1)}`;
    await expect(reloaded.getByLabel(`${label} from`)).toHaveValue(from);
    await expect(reloaded.getByLabel(`${label} to`)).toHaveValue(to);
  }

  // Save a change to Tuesday only; Monday must come back exactly as it was.
  await page.getByRole('group', { name: 'Tuesday' }).getByLabel('Hours from').fill('10:00');
  await page.getByRole('group', { name: 'Tuesday' }).getByLabel('Hours to').fill('16:00');
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(saved(page, 'Weekly hours')).toHaveText('Working hours saved.');
  await page.reload();
  const after = page.getByRole('group', { name: 'Monday' });
  for (const [index, [from, to]] of ranges.entries()) {
    const label = index === 0 ? 'Hours' : `Hours ${String(index + 1)}`;
    await expect(after.getByLabel(`${label} from`)).toHaveValue(from);
    await expect(after.getByLabel(`${label} to`)).toHaveValue(to);
  }
  await expect(after.getByLabel('Break from')).toHaveValue('10:00');
  await expect(after.getByLabel('Break 2 from')).toHaveValue('14:00');
  await expect(page.getByRole('group', { name: 'Tuesday' }).getByLabel('Hours to')).toHaveValue(
    '16:00',
  );
  await expectNoHorizontalScroll(page);
});

test('the business type is locked once a service exists, with a clear settings message', async ({
  page,
}) => {
  const slug = await newBusiness(page, 'Event planner');

  // Event planners default to request mode at a venue.
  await createService(page, slug, 'Wedding planning');
  await expect(page.getByLabel('Booking mode')).toHaveValue('request');
  await expect(page.getByLabel('Where')).toHaveValue('venue');

  await page.goto(`/app/${slug}/settings`);
  await expect(page.getByTestId('business-type-locked')).toBeVisible();
  await page.getByRole('radio', { name: 'Other appointment-based business' }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(errorBanner(page)).toHaveText(
    'The business type cannot be changed once the business has services. Delete every service first if the type was chosen by mistake.',
  );
  // The form keeps what was submitted; the stored type is unchanged.
  await expect(page.getByRole('radio', { name: 'Other appointment-based business' })).toBeChecked();
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Event planner' })).toBeChecked();
  await expectNoHorizontalScroll(page);
});

test("another tenant's service and team member ids are 404s, and unpublishing keeps the service for members", async ({
  page,
  browser,
}) => {
  const slugA = await newBusiness(page, 'Event planner');
  const serviceA = await createService(page, slugA, 'Private service');
  await page.goto(`/app/${slugA}/team`);
  await page.getByLabel('Display name').fill('Planner Bea');
  await page.getByRole('button', { name: 'Add team member' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Planner Bea' })).toBeVisible();
  const memberA = /team\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  expect(memberA).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto(`/app/${slugA}/services/${serviceA}`);

  const other = await newClientContext(browser);
  try {
    const pageB = await other.newPage();
    const slugB = await newBusiness(pageB, 'Midwife');
    const response = await pageB.goto(`/app/${slugB}/services/${serviceA}`);
    expect(response?.status()).toBe(404);
    const teamResponse = await pageB.goto(`/app/${slugB}/team/${memberA}`);
    expect(teamResponse?.status()).toBe(404);
  } finally {
    await other.close();
  }

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('service-status')).toHaveText('Published');
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await expect(saved(page, 'Publishing')).toHaveText(
    'Service unpublished: hidden from public pages.',
  );
  await page.goto(`/app/${slugA}/services`);
  await expect(page.getByTestId(`published-${serviceA}`)).toHaveText('unpublished');
});

test('the proxy refuses a server-action POST with a foreign Origin (403)', async ({ request }) => {
  // Includes a path that looks like a static file: a dynamic segment matches it, so it must be gated.
  for (const path of [
    '/app/anything/settings',
    '/onboarding',
    '/app/anything/services',
    '/app/anything/services/x.png',
  ]) {
    const response = await request.post(path, {
      headers: {
        origin: 'https://evil.example',
        'next-action': '7f00000000000000000000000000000000000000',
        'content-type': 'text/plain;charset=UTF-8',
      },
      data: '[]',
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(403);
    expect(await response.text(), path).toBe('Forbidden');
  }
});
