import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { rejectCrossOrigin, seeOther, siteOrigin, tooManyRequests } from '@/app/_lib/http';

/**
 * Phase 2 follow-up 5: the route handlers that answer 429 check their own origin (route handlers
 * sit outside React's server-action origin check) and the 429 response is generic.
 */
const SITE = 'http://localhost:3000';

function post(headers: Record<string, string>): NextRequest {
  return new NextRequest(`${SITE}/auth/password`, { method: 'POST', headers });
}

describe('rejectCrossOrigin', () => {
  it('accepts a same-site Origin, or a same-site Referer when Origin is absent', () => {
    expect(rejectCrossOrigin(post({ origin: SITE }))).toBeNull();
    expect(rejectCrossOrigin(post({ referer: `${SITE}/sign-in?next=%2Fapp` }))).toBeNull();
  });

  it('refuses with 403 when the Origin is another site, even with a same-site Referer', () => {
    const response = rejectCrossOrigin(post({ origin: 'https://evil.example', referer: SITE }));
    expect(response?.status).toBe(403);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses when neither header is present, or the Referer is another site or malformed', () => {
    expect(rejectCrossOrigin(post({}))?.status).toBe(403);
    expect(rejectCrossOrigin(post({ referer: 'https://evil.example/sign-in' }))?.status).toBe(403);
    expect(rejectCrossOrigin(post({ referer: 'not a url' }))?.status).toBe(403);
    expect(rejectCrossOrigin(post({ origin: 'null' }))?.status).toBe(403);
  });

  it('treats a different port or scheme as another site', () => {
    expect(rejectCrossOrigin(post({ origin: 'http://localhost:3100' }))?.status).toBe(403);
    expect(rejectCrossOrigin(post({ origin: 'https://localhost:3000' }))?.status).toBe(403);
  });

  it('judges the site by the proxy headers, not by the listen address (ADR-004 §9)', () => {
    // Behind a reverse proxy the Node server sees localhost; the browser sees the public host.
    const proxied = {
      host: 'localhost:3000',
      'x-forwarded-host': 'app.example',
      'x-forwarded-proto': 'https',
    };
    expect(siteOrigin(post(proxied))).toBe('https://app.example');
    expect(rejectCrossOrigin(post({ ...proxied, origin: 'https://app.example' }))).toBeNull();
    expect(rejectCrossOrigin(post({ ...proxied, origin: 'http://app.example' }))?.status).toBe(403);
    expect(rejectCrossOrigin(post({ ...proxied, origin: 'https://evil.example' }))?.status).toBe(
      403,
    );
    // A list of forwarded hosts (several proxies) uses the first, the one the browser used.
    expect(siteOrigin(post({ ...proxied, 'x-forwarded-host': 'app.example, internal.lb' }))).toBe(
      'https://app.example',
    );
    // Reached directly (local dev, CI): the Host header is the site.
    expect(siteOrigin(post({ host: 'localhost:3100' }))).toBe('http://localhost:3100');
    expect(
      rejectCrossOrigin(post({ host: 'localhost:3100', origin: 'http://localhost:3100' })),
    ).toBeNull();
  });
});

describe('seeOther', () => {
  it('redirects with a path-relative Location so no host is ever guessed', () => {
    const response = seeOther('/app');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/app');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('percent-encodes the path (header values are Latin-1) and keeps it on this site', () => {
    expect(seeOther('/app/中').headers.get('location')).toBe('/app/%E4%B8%AD');
    expect(seeOther('/app/x y?q=ü').headers.get('location')).toBe('/app/x%20y?q=%C3%BC');
    expect(seeOther('//evil.example/app').headers.get('location')).toBe('/app');
  });
});

describe('siteOrigin normalisation', () => {
  it('drops a default port and lower-cases the host, as the browser Origin does', () => {
    const proxied = { host: 'localhost:3000', 'x-forwarded-proto': 'https' };
    expect(siteOrigin(post({ ...proxied, 'x-forwarded-host': 'app.example:443' }))).toBe(
      'https://app.example',
    );
    expect(siteOrigin(post({ ...proxied, 'x-forwarded-host': 'App.Example' }))).toBe(
      'https://app.example',
    );
    expect(
      rejectCrossOrigin(
        post({ ...proxied, 'x-forwarded-host': 'app.example:443', origin: 'https://app.example' }),
      ),
    ).toBeNull();
  });
});

describe('tooManyRequests', () => {
  it('answers 429 with Retry-After, no caching and the one generic message', async () => {
    const response = tooManyRequests(570, '/sign-in');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('570');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('Too many attempts');
    expect(body).toContain('Try again in a few minutes.');
    expect(body).toContain('href="/sign-in"');
  });

  it('escapes the back link so a crafted path cannot inject markup', async () => {
    const body = await tooManyRequests(1, '/sign-in"><script>alert(1)</script>').text();
    expect(body).not.toContain('<script>');
    expect(body).toContain('&#34;&#62;&#60;script&#62;');
  });
});
