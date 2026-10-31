import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 3, Phase 2 follow-up 1: the request interceptor refuses every cross-origin request that
 * is not a GET or HEAD, with the same APP_ORIGIN allow-list as the form route handlers, so server
 * actions no longer depend on Next's Host-based origin check. The refusal happens before any
 * session work, so no Supabase call is made for a refused request.
 */
const SITE = 'http://localhost:3000';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
// Unroutable on purpose: a request that reached the session step without cookies never calls it.
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:9');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', SITE);

const { proxy } = await import('@/proxy');

function request(method: string, path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${SITE}${path}`, { method, headers });
}

// The shape of a server-action POST: a page path plus the Next-Action header.
const serverAction = { 'next-action': '7f00000000000000000000000000000000000000' };

describe('proxy origin gate', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'refuses a cross-origin %s with 403 before any session work',
    async (method) => {
      const response = await proxy(
        request(method, '/app/some-business/settings', {
          ...serverAction,
          origin: 'https://evil.example',
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('Forbidden');
    },
  );

  it('refuses a server-action POST with a spoofed Host that matches the foreign Origin', async () => {
    // Next's own check compares Origin with Host/X-Forwarded-Host, which the client controls when
    // it reaches the server directly. The allow-list comes from APP_ORIGIN alone.
    const response = await proxy(
      request('POST', '/app/some-business/settings', {
        ...serverAction,
        origin: 'https://evil.example',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses a POST with neither Origin nor Referer, and one with Origin: null', async () => {
    expect((await proxy(request('POST', '/app/x/services', serverAction))).status).toBe(403);
    expect(
      (await proxy(request('POST', '/app/x/services', { ...serverAction, origin: 'null' }))).status,
    ).toBe(403);
  });

  it('refuses a different port or scheme of the same host', async () => {
    for (const origin of ['http://localhost:3100', 'https://localhost:3000']) {
      expect((await proxy(request('POST', '/onboarding', { origin }))).status).toBe(403);
    }
  });

  it('lets a same-origin POST through, signed out too: the action or route answers for itself', async () => {
    const response = await proxy(
      request('POST', '/app/x/settings', { ...serverAction, origin: SITE }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
  });

  it('still redirects a signed-out page load to sign-in', async () => {
    const response = await proxy(request('GET', '/app/x/settings'));
    expect(response.headers.get('location')).toBe(`${SITE}/sign-in?next=%2Fapp%2Fx%2Fsettings`);
  });

  it.each(['GET', 'HEAD'])('never applies the gate to %s, whatever the Origin', async (method) => {
    const response = await proxy(request(method, '/', { origin: 'https://evil.example' }));
    expect(response.status).not.toBe(403);
  });

  it.each(['/app/x/services/a.png', '/health', '/favicon.ico', '/_next/image', '/app/x/y.js'])(
    'gates a POST to %s like any other path',
    async (path) => {
      const response = await proxy(
        request('POST', path, { ...serverAction, origin: 'https://evil.example' }),
      );
      expect(response.status).toBe(403);
    },
  );

  it.each(['/app/x/services/a.png', '/health'])(
    'lets a GET of %s through without a session redirect',
    async (path) => {
      const response = await proxy(request('GET', path));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    },
  );
});
