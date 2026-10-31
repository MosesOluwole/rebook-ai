'use server';

import { redirect } from 'next/navigation';

import { getAuthSession } from '../_lib/session';

/**
 * Sign-out is the one auth server action. Sign-in, sign-up and the magic link post to route
 * handlers under /auth so a rate-limited attempt can be answered with a real 429
 * (docs/adr/ADR-004 §9).
 */
export async function signOut(): Promise<void> {
  const auth = await getAuthSession();
  await auth.signOut();
  redirect('/sign-in');
}
