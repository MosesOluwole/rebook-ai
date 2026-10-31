import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 2 follow-up 5: the route handlers that answer 429 check their own origin (route handlers
 * sit outside React's server-action origin check) and the 429 response is generic. The site is
 * the configured APP_ORIGIN; NODE_ENV=test, so no loopback variants are added.
 */
const SITE = 'http://localhost:3000';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', SITE);

const { rejectCrossOrigin, seeOther, tooManyRequests } = await import('@/app/_lib/http');

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

  it('accepts no loopback twin outside development', () => {
    expect(rejectCrossOrigin(post({ origin: 'http://127.0.0.1:3000' }))?.status).toBe(403);
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
