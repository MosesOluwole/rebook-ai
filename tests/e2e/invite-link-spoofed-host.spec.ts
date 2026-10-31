import { expect, test } from './helpers/fixtures';

import { onboard, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Phase 2 follow-ups, criterion 5 (ADR-004 §9): the invite link is built on APP_ORIGIN even when
 * the request's Host header is spoofed. Browsers will not override Host, so the invite action is
 * posted as a no-JavaScript form submission (the progressive-enhancement fields React renders
 * into the server HTML) through the request API, which does send the spoofed Host.
 *
 * Self-checking: the Origin sent is the spoofed host, and Next runs a server action only when
 * Origin matches X-Forwarded-Host or, without it, Host. A rendered link therefore proves the
 * server received the spoofed Host (or X-Forwarded-Host) and still built the link on APP_ORIGIN.
 */

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The hidden fields of the server-rendered invite form (slug plus React's $ACTION_* fields). */
function inviteFormFields(html: string): Record<string, string> {
  const form = /<form[^>]*>(?:(?!<\/form>)[\s\S])*name="slug"(?:(?!<\/form>)[\s\S])*<\/form>/.exec(
    html,
  )?.[0];
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

test('an invite link posted with a spoofed Host is still built on APP_ORIGIN', async ({
  page,
  baseURL,
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
    expect(response.status(), variant.label).toBe(200);
    const body = await response.text();
    const link = /data-testid="invite-link"[^>]*>([^<]*)</.exec(body)?.[1];
    expect(link, `${variant.label}: the action ran and rendered a link`).toBeDefined();
    const prefix = `${baseURL ?? ''}/invite/${slug}/`;
    expect(link?.startsWith(prefix), `${variant.label}: ${String(link)}`).toBe(true);
    expect(link?.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body).not.toContain('evil.example/invite');
  }
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
