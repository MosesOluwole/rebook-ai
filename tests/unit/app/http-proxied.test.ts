import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Origin hardening (ADR-004 §9): the same-origin check compares the Origin header (the Referer
 * only when Origin is absent) with an allow-list built from APP_ORIGIN, and never reads Host or
 * X-Forwarded-*. Redirects stay path-relative. Synthetic environment, no network.
 */
const APP_ORIGIN = 'https://app.example';
const LISTEN = 'http://localhost:3000';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', APP_ORIGIN);

const { allowedOrigins, rejectCrossOrigin, routeAnswer, seeOther, temporaryRedirect } =
  await import('@/app/_lib/http');

function request(headers: Record<string, string>, method = 'POST'): NextRequest {
  return new NextRequest(`${LISTEN}/auth/password`, { method, headers });
}

describe('allowedOrigins', () => {
  it('is APP_ORIGIN alone in production and test', () => {
    for (const NODE_ENV of ['production', 'test'] as const) {
      expect([...allowedOrigins({ NODE_ENV, APP_ORIGIN: 'http://localhost:3000' })]).toEqual([
        'http://localhost:3000',
      ]);
    }
  });

  it('adds the loopback twins on the same scheme and port in development only', () => {
    expect([
      ...allowedOrigins({ NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:3000' }),
    ]).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']);
    expect([
      ...allowedOrigins({ NODE_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:3200' }),
    ]).toEqual(['http://127.0.0.1:3200', 'http://localhost:3200', 'http://[::1]:3200']);
  });

  it('adds nothing in development when APP_ORIGIN is not a loopback address', () => {
    expect([
      ...allowedOrigins({ NODE_ENV: 'development', APP_ORIGIN: 'https://dev.app.example' }),
    ]).toEqual(['https://dev.app.example']);
  });
});

describe('rejectCrossOrigin ignores Host and X-Forwarded-*', () => {
  it('accepts APP_ORIGIN whatever the host headers claim', () => {
    expect(rejectCrossOrigin(request({ origin: APP_ORIGIN }))).toBeNull();
    expect(
      rejectCrossOrigin(
        request({
          origin: APP_ORIGIN,
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        }),
      ),
    ).toBeNull();
  });

  it('refuses a foreign Origin even when the forwarded headers agree with it', () => {
    const spoofed = {
      origin: 'https://evil.example',
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    };
    expect(rejectCrossOrigin(request(spoofed))?.status).toBe(403);
  });

  it('refuses the listen address: that is not the configured site', () => {
    expect(rejectCrossOrigin(request({ origin: LISTEN }))?.status).toBe(403);
  });
});

describe('rejectCrossOrigin header precedence', () => {
  it('uses the Referer only when Origin is absent', () => {
    expect(rejectCrossOrigin(request({ referer: `${APP_ORIGIN}/sign-in?next=%2Fapp` }))).toBeNull();
    expect(rejectCrossOrigin(request({ referer: `${LISTEN}/sign-in` }))?.status).toBe(403);
    // A present Origin decides, even when it is empty, opaque or foreign and the Referer is ours.
    for (const origin of ['', 'null', 'https://evil.example']) {
      expect(
        rejectCrossOrigin(request({ origin, referer: `${APP_ORIGIN}/sign-in` }))?.status,
        `origin ${JSON.stringify(origin)}`,
      ).toBe(403);
    }
  });

  it('compares serialised origins, so case and a default port do not matter', () => {
    expect(rejectCrossOrigin(request({ origin: 'HTTPS://App.Example:443' }))).toBeNull();
    expect(rejectCrossOrigin(request({ origin: 'https://app.example:8443' }))?.status).toBe(403);
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

  it('routeAnswer: a form post gets a relative 303 or an HTML page, never a message in a URL', async () => {
    const post = (accept?: string) =>
      new NextRequest('http://localhost:3000/auth/password', {
        method: 'POST',
        headers: accept === undefined ? {} : { accept },
      });
    const redirect = routeAnswer(post(), { redirect: '/app/x?y=1' });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe('/app/x?y=1');

    const page = routeAnswer(post(), {
      ok: false,
      status: 400,
      message: 'Check the form: a & b.',
      backTo: '/sign-up',
    });
    expect(page.status).toBe(400);
    expect(page.headers.get('location')).toBeNull();
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Check the form: a &#38; b.');

    const json = routeAnswer(post('application/json'), {
      ok: false,
      status: 401,
      message: 'Incorrect email or password',
      backTo: '/sign-in',
    });
    expect(json.status).toBe(401);
    expect(await json.json()).toEqual({ ok: false, message: 'Incorrect email or password' });

    const jsonRedirect = routeAnswer(post('application/json'), { redirect: '//evil.example/x' });
    expect(jsonRedirect.status).toBe(200);
    expect(await jsonRedirect.json()).toEqual({ ok: true, redirect: '/x' });
  });

  it('never emits an absolute Location, whatever the request looked like', () => {
    for (const path of ['/app', '/onboarding', '/invite/s/t?member=1']) {
      expect(seeOther(path).headers.get('location')).toBe(path);
      expect(temporaryRedirect(path).headers.get('location')).toBe(path);
      expect(seeOther(path).headers.get('location')?.startsWith('/')).toBe(true);
    }
  });
});
