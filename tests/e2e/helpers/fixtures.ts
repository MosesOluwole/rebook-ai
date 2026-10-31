import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
} from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Rate limits key on the client IP read from CLIENT_IP_HEADER (x-forwarded-for locally and in
 * CI). Every test presents itself as a fresh client, and every secondary browser context a test
 * opens goes through `newClientContext`, so only tests that mean to hit a limit ever do.
 */
const octet = () => Math.floor(Math.random() * 254) + 1;

export const freshIp = (): string => `10.${octet()}.${octet()}.${octet()}`;

export const test = base.extend({
  // Playwright's fixture callback; named `provide` so the React hooks lint rule does not read
  // it as a `use` hook.
  contextOptions: async ({ contextOptions }, provide) => {
    await provide({
      ...contextOptions,
      extraHTTPHeaders: { ...contextOptions.extraHTTPHeaders, 'x-forwarded-for': freshIp() },
    });
  },
});

/** A second browser (another person) with its own client IP, plus any extra options. */
export function newClientContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({
    ...options,
    extraHTTPHeaders: { ...options.extraHTTPHeaders, 'x-forwarded-for': freshIp() },
  });
}
