import { expect, test } from './helpers/fixtures';

import { onboard, signUp, uniqueEmail } from './helpers/accounts';

/**
 * Test-engineer addition (Phase 3). Since the proxy refuses every foreign-Origin POST,
 * invite-link-spoofed-host.spec.ts and proxied-origin.spec.ts now prove the refusal, and the
 * invite action no longer runs under a spoofed Host in any e2e test. This keeps that Phase 2
 * property (ADR-004 §9: links are built on APP_ORIGIN, never on Host or X-Forwarded-*) proven
 * end to end: the Origin is APP_ORIGIN, so the proxy lets the POST through, and X-Forwarded-Host
 * names APP_ORIGIN's host so Next's own server-action check passes, while the Host header (and
 * X-Forwarded-Proto) are spoofed. The rendered link must still start with APP_ORIGIN.
 */

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The hidden fields of the server-rendered invite form. Since Phase 3 the team page has several
 * forms carrying a hidden slug, so the invite form is the one with the email input.
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

test('an invite posted from APP_ORIGIN with a spoofed Host still gets a link on APP_ORIGIN', async ({
  page,
  baseURL,
}) => {
  const origin = baseURL ?? '';
  const appHost = new URL(origin).host;
  await signUp(page, uniqueEmail('gate-owner'));
  const slug = await onboard(page, 'Gate Host Events', 'Event planner');

  const html = await (await page.request.get(`/app/${slug}/team`)).text();
  const hidden = inviteFormFields(html);
  expect(Object.keys(hidden).some((name) => name.startsWith('$ACTION'))).toBe(true);

  const response = await page.request.post(`/app/${slug}/team`, {
    multipart: { ...hidden, email: uniqueEmail('gate-invitee'), role: 'staff' },
    headers: {
      host: 'evil.example',
      'x-forwarded-host': appHost,
      'x-forwarded-proto': 'https',
      origin,
    },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  const body = await response.text();
  const link = /data-testid="invite-link"[^>]*>([^<]*)</.exec(body)?.[1];
  expect(link, 'the action ran and rendered a link').toBeDefined();
  const prefix = `${origin}/invite/${slug}/`;
  expect(link?.startsWith(prefix), String(link)).toBe(true);
  expect(link?.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(body).not.toContain('evil.example/invite');
  expect(body).not.toContain(`https://${appHost}/invite`);
});
