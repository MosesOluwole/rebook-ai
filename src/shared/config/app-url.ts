import { getEnv } from './env';

/**
 * An absolute link into the app for anything sent outside the current response: invitation
 * links, the request interceptor's sign-in redirect, and later sign-in and booking links. Always
 * on the configured APP_ORIGIN, never on a host taken from the request (docs/adr/ADR-004 §9), so
 * a spoofed Host or X-Forwarded-Host cannot point a link at another site.
 */
export function appUrl(path: string): string {
  const url = new URL(path, getEnv().APP_ORIGIN);
  // A `//host/...` path would resolve to another origin; links only ever stay on this site.
  if (url.origin !== getEnv().APP_ORIGIN) {
    throw new Error('appUrl: the path must be relative to the app origin');
  }
  return url.toString();
}
