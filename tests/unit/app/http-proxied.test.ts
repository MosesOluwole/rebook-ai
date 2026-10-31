import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  backToForm,
  rejectCrossOrigin,
  seeOther,
  siteOrigin,
  temporaryRedirect,
} from '@/app/_lib/http';

/**
 * B1 (code review): behind a reverse proxy `request.nextUrl` is the listen address, so the site
 * the browser sees must come from the forwarded headers (or Host) and every redirect must be
 * path-relative. These cases complete the coordinator's http.test.ts.
 */
const LISTEN = 'http://localhost:3000';

function request(headers: Record<string, string>, method = 'POST'): NextRequest {
  return new NextRequest(`${LISTEN}/auth/password`, { method, headers });
}

describe('siteOrigin behind a proxy', () => {
  it('uses the first forwarded host and the first forwarded proto', () => {
    expect(
      siteOrigin(
        request({
          host: 'localhost:3000',
          'x-forwarded-host': 'app.example, edge.internal',
          'x-forwarded-proto': 'https, http',
        }),
      ),
    ).toBe('https://app.example');
  });

  it('keeps a non-default port on the forwarded host', () => {
    expect(
      siteOrigin(
        request({
          host: 'localhost:3000',
          'x-forwarded-host': 'app.example:8443',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe('https://app.example:8443');
  });

  it('falls back to the listen protocol when the proxy forwards the host but not the proto', () => {
    // A TLS-terminating proxy that omits x-forwarded-proto makes the site look like http, and a
    // browser posting from https://app.example would then be refused: the proxy must send both.
    expect(siteOrigin(request({ host: 'localhost:3000', 'x-forwarded-host': 'app.example' }))).toBe(
      'http://app.example',
    );
    expect(
      rejectCrossOrigin(
        request({
          host: 'localhost:3000',
          'x-forwarded-host': 'app.example',
          origin: 'https://app.example',
        }),
      )?.status,
    ).toBe(403);
  });

  it('falls back to Host when the forwarded host is present but blank, and to the listen address only when no host exists', () => {
    // A proxy that sends an empty x-forwarded-host is misconfigured but harmless: Host still
    // names the site. Only when no host at all is available does the site fall back to the
    // listen address, which fails closed for same-origin posts.
    expect(
      siteOrigin(request({ host: 'app.example', 'x-forwarded-host': '', 'x-forwarded-proto': '' })),
    ).toBe('http://app.example');
    expect(siteOrigin(request({ host: 'app.example', 'x-forwarded-host': ' , ' }))).toBe(
      'http://app.example',
    );
    expect(siteOrigin(request({ host: 'app.example' }))).toBe('http://app.example');
    expect(siteOrigin(new NextRequest(`${LISTEN}/auth/password`, { method: 'POST' }))).toBe(
      'http://localhost:3000',
    );
  });
});

describe('rejectCrossOrigin behind a proxy', () => {
  const proxied = {
    host: 'localhost:3000',
    'x-forwarded-host': 'app.example',
    'x-forwarded-proto': 'https',
  };

  it('refuses an Origin equal to the listen address: that is not the site the browser sees', () => {
    expect(rejectCrossOrigin(request({ ...proxied, origin: LISTEN }))?.status).toBe(403);
  });

  it('accepts a same-site Referer when Origin is absent, judged against the forwarded site', () => {
    expect(
      rejectCrossOrigin(
        request({ ...proxied, referer: 'https://app.example/sign-in?next=%2Fapp' }),
      ),
    ).toBeNull();
    expect(rejectCrossOrigin(request({ ...proxied, referer: `${LISTEN}/sign-in` }))?.status).toBe(
      403,
    );
  });

  it('is case-insensitive on the host part because URL origins are', () => {
    // siteOrigin normalises through the URL parser like the browser does, so a proxy that
    // forwards a mixed-case host still matches the lower-cased Origin.
    expect(
      rejectCrossOrigin(
        request({ ...proxied, 'x-forwarded-host': 'App.Example', origin: 'https://app.example' }),
      ),
    ).toBeNull();
  });
});

describe('path-relative redirects', () => {
  it('temporaryRedirect answers 307 with a relative Location and no caching', () => {
    const response = temporaryRedirect('/sign-in?error=x');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/sign-in?error=x');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toBeNull();
  });

  it('backToForm encodes every parameter and stays relative', () => {
    const response = backToForm('/sign-up', {
      error: 'Check the form: a & b.',
      next: '/app/x?y=1',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/sign-up?error=Check+the+form%3A+a+%26+b.&next=%2Fapp%2Fx%3Fy%3D1',
    );
  });

  it('never emits an absolute Location, whatever the request looked like', () => {
    for (const path of ['/app', '/onboarding', '/invite/s/t?member=1']) {
      expect(seeOther(path).headers.get('location')).toBe(path);
      expect(temporaryRedirect(path).headers.get('location')).toBe(path);
      expect(seeOther(path).headers.get('location')?.startsWith('/')).toBe(true);
    }
  });
});
