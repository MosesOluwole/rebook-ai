import { randomUUID } from 'node:crypto';

import { combineChunks, createChunks, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { NextRequest, type NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proxy } from '@/proxy';
import { SESSION_COOKIE_NAME } from '@/shared/auth/supabase';
import { getEnv } from '@/shared/config/env';
import { type DbClient } from '@/shared/db/client';

import { connectOwnerDb } from '../../helpers/db';
import { removeAuthUsers } from '../../helpers/tenant-fixtures';

/**
 * Phase 3, Phase 2 follow-up 4: the request interceptor refreshes a session whose access token
 * is about to expire and writes the refreshed cookies to the response (for the browser) and to
 * the forwarded request (for the page rendering this request).
 *
 * Least invasive route, with no JWT secret anywhere: a real session is obtained from the local
 * Supabase Auth by signing a synthetic user up, then the cookie is written exactly as @supabase/ssr writes
 * it, with only `expires_at` moved to 30 seconds from now. supabase-js refreshes when a session
 * is within 90 seconds of `expires_at` (EXPIRY_MARGIN_MS), so the proxy must spend the real
 * refresh token with the Auth server and get a genuinely new session back. Nothing is mocked:
 * the proxy, the Auth server and the cookie codec are the production ones.
 */

const PASSWORD = 'synthetic-refresh-password';
const APP = 'http://localhost:3000';

interface Session {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly user: { readonly id: string };
}

let owner: DbClient;
let session: Session;

/** Signs a synthetic user up through the local Auth server (confirmations are off locally). */
async function signUp(email: string): Promise<Session> {
  const env = getEnv();
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`sign-up failed with HTTP ${String(response.status)}`);
  }
  const body = (await response.json()) as Partial<Session>;
  if (typeof body.refresh_token !== 'string') {
    throw new Error('sign-up returned no session; are email confirmations on locally?');
  }
  return body as Session;
}

/** The Cookie header @supabase/ssr would read for this session (base64url, chunked). */
function sessionCookieHeader(value: Session): string {
  const encoded = `base64-${stringToBase64URL(JSON.stringify(value))}`;
  return createChunks(SESSION_COOKIE_NAME, encoded)
    .map((chunk) => `${chunk.name}=${chunk.value}`)
    .join('; ');
}

/** Decodes the session the proxy wrote to the response, or null when it wrote none. */
async function sessionWrittenTo(response: NextResponse): Promise<Session | null> {
  const written = response.cookies.getAll().filter((c) => c.name.startsWith(SESSION_COOKIE_NAME));
  if (written.length === 0) {
    return null;
  }
  const byName = new Map(written.map((c) => [c.name, c.value]));
  const combined = await combineChunks(SESSION_COOKIE_NAME, (name) => byName.get(name));
  if (!combined?.startsWith('base64-')) {
    throw new Error('the proxy wrote a session cookie in an unexpected encoding');
  }
  return JSON.parse(stringFromBase64URL(combined.slice('base64-'.length))) as Session;
}

function requestWith(cookie: string): NextRequest {
  return new NextRequest(`${APP}/app`, { method: 'GET', headers: { cookie } });
}

beforeAll(async () => {
  owner = await connectOwnerDb({ max: 1 });
  session = await signUp(`refresh-${randomUUID().slice(0, 8)}@example.invalid`);
});

afterAll(async () => {
  await removeAuthUsers(owner, [session.user.id]);
  await owner.close();
});

describe('proxy session refresh', () => {
  it('refreshes a session within the expiry margin and writes the new cookies', async () => {
    const nearExpiry = { ...session, expires_at: Math.floor(Date.now() / 1000) + 30 };
    const response = await proxy(requestWith(sessionCookieHeader(nearExpiry)));

    // Signed in: the protected page is let through, not redirected to sign-in.
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');

    // The browser gets a genuinely new session from the Auth server.
    const refreshed = await sessionWrittenTo(response);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.user.id).toBe(session.user.id);
    expect(refreshed?.refresh_token).not.toBe(session.refresh_token);
    expect(refreshed?.access_token).not.toBe(session.access_token);
    expect(refreshed?.expires_at).toBeGreaterThan(nearExpiry.expires_at + 600);
    for (const cookie of response.cookies
      .getAll()
      .filter((c) => c.name.startsWith(SESSION_COOKIE_NAME))) {
      expect(cookie.httpOnly, cookie.name).toBe(true);
      expect(cookie.sameSite, cookie.name).toBe('lax');
      expect(cookie.path, cookie.name).toBe('/');
    }

    // The page rendering this same request sees the refreshed cookies too (forwarded request).
    const forwarded = response.headers.get('x-middleware-request-cookie') ?? '';
    const firstChunk = response.cookies
      .getAll()
      .find((c) => c.name.startsWith(SESSION_COOKIE_NAME));
    expect(firstChunk).toBeDefined();
    expect(forwarded).toContain(`${firstChunk?.name ?? ''}=${firstChunk?.value ?? ''}`);
  });

  it('leaves a session that is far from expiry alone (no refresh, no cookie written)', async () => {
    const response = await proxy(requestWith(sessionCookieHeader(session)));
    expect(response.headers.get('location')).toBeNull();
    expect(await sessionWrittenTo(response)).toBeNull();
  });
});
