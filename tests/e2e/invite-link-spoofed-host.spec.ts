import { expect, test } from './helpers/fixtures';

import { onboard, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Phase 2 follow-ups, criterion 5 (ADR-004 §9), tightened in Phase 3. Browsers will not override
 * Host, so the invite action is posted as a no-JavaScript form submission (the
 * progressive-enhancement fields React renders into the server HTML) through the request API,
 * which does send the spoofed Host.
 *
 * Next runs a server action only when Origin matches X-Forwarded-Host or, without it, Host, so the
 * attack sends an Origin that agrees with the spoofed host. In Phase 2 that let the action run and
 * the test proved the link was still built on APP_ORIGIN. Since Phase 3 the request interceptor
 * refuses every cross-origin non-GET against APP_ORIGIN first: the same request now gets 403 and
 * the action never runs, so no invitation exists at all. That links are built on APP_ORIGIN is
 * still proven by src/shared/config/app-url.test.ts and the browser test in proxied-origin.spec.ts
 * would show it if a spoofed request ever got through again.
 */

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The hidden fields of the server-rendered invite form (slug plus React's $ACTION_* fields).
 * Since Phase 3 the team page has other forms with a hidden slug before this one (add team
 * member, revoke), so the invite form is picked by its email input.
 */
function inviteFormFields(html: string): Record<string, string> {
  const form = [...html.matchAll(/<form[^>]*>(?:(?!<\/form>)[\s\S])*<\/form>/g)]
    .map(([match]) => match)
    .find((candidate) => candidate.includes('name="email"') && candidate.includes('name="slug"'));
  if (form === undefined) {
    throw new Error('invite form not found in the server HTML');
  }
  const fields: Record<string, string> = {};
  for (const [input] of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(input)?.[1];
    if (name !== undefined) {
      fields[decode(name)] = decode(/value="([^"]*)"/.exec(input)?.[1] ?? '');
    }
  }
  return fields;
}

const VARIANTS = [
  { label: 'spoofed Host', headers: { host: 'evil.example', origin: 'http://evil.example' } },
  {
    label: 'spoofed Host and X-Forwarded-Host',
    headers: {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      origin: 'https://evil.example',
    },
  },
] as const;

test('an invite posted with a spoofed Host and matching Origin is refused before the action runs', async ({
  page,
}) => {
  await signUp(page, uniqueEmail('host-owner'));
  const slug = await onboard(page, 'Host Spoof Events', 'Event planner');

  const html = await (await page.request.get(`/app/${slug}/team`)).text();
  const hidden = inviteFormFields(html);
  expect(Object.keys(hidden).some((name) => name.startsWith('$ACTION'))).toBe(true);
  expect(hidden.slug).toBe(slug);

  for (const variant of VARIANTS) {
    const response = await page.request.post(`/app/${slug}/team`, {
      multipart: { ...hidden, email: uniqueEmail('host-invitee'), role: 'staff' },
      headers: variant.headers,
      maxRedirects: 0,
    });
    expect(response.status(), variant.label).toBe(403);
    const body = await response.text();
    expect(body, variant.label).toBe('Forbidden');
    expect(body).not.toContain('/invite/');
  }

  // Nothing was created: the owner's own view lists no open invitation.
  await page.goto(`/app/${slug}/team`);
  await expect(
    page.getByRole('region', { name: 'Open invitations' }).getByText('None.'),
  ).toBeVisible();
});

test('invitation acceptance, the fourth form route, refuses a foreign Origin with 403 before anything else', async ({
  page,
  baseURL,
}) => {
  await signUp(page, uniqueEmail('accept-origin'));
  const path = '/invite/some-business/not-a-real-token-value/accept';
  const variants: readonly Record<string, string>[] = [
    { origin: 'https://evil.example' },
    { origin: 'https://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    { origin: 'https://evil.example', referer: `${baseURL ?? ''}/invite/some-business/x` },
    { origin: 'null' },
    { referer: 'https://evil.example/page' },
  ];
  for (const headers of variants) {
    const response = await page.request.post(path, { form: {}, headers, maxRedirects: 0 });
    expect(response.status(), JSON.stringify(headers)).toBe(403);
  }
  // Control: from APP_ORIGIN the route proceeds past the origin check (to its own answer).
  const own = await page.request.post(path, {
    form: {},
    headers: { origin: baseURL ?? '' },
    maxRedirects: 0,
  });
  expect(own.status()).not.toBe(403);
});
