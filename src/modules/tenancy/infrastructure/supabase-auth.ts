import { type AuthError, type User } from '@supabase/supabase-js';

import { type SupabaseAuthOnlyClient } from '@/shared/auth/supabase';

import { type AuthGateway, type SignUpOutcome } from '../application/ports';
import { AuthProviderError, InvalidCredentialsError, InvalidTokenError } from '../domain/errors';
import { authenticatedUserSchema, type AuthenticatedUser } from '../domain/user';

/**
 * Supabase Auth behind the AuthGateway port (docs/adr/ADR-004-auth-sessions.md). Identity comes
 * from `getClaims()`, which verifies the access token (signature and expiry, against the
 * project's keys or the Auth server), never from decoding the cookie payload. Email links carry a
 * token hash that this server verifies with `verifyOtp`, so a link works in any browser.
 */
export function createSupabaseAuthGateway(client: SupabaseAuthOnlyClient): AuthGateway {
  return {
    async currentUser(): Promise<AuthenticatedUser | null> {
      const { data, error } = await client.auth.getClaims();
      if (error !== null || data === null) {
        return null;
      }
      const claims = data.claims;
      // Advisory only: user_metadata is user-editable. Decisions that depend on a verified
      // address (invite acceptance) use currentUserVerified(), a fresh read from the server.
      const metadata: unknown = claims.user_metadata;
      const emailVerified =
        typeof metadata === 'object' &&
        metadata !== null &&
        (metadata as { email_verified?: unknown }).email_verified === true;
      return toUser({ id: claims.sub, email: claims.email, emailVerified });
    },

    async currentUserVerified(): Promise<AuthenticatedUser | null> {
      const { data, error } = await client.auth.getUser();
      if (error !== null) {
        return null;
      }
      return toUser(fromUser(data.user));
    },

    async signUpWithPassword({ email, password }): Promise<SignUpOutcome> {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error !== null) {
        throw providerError(error);
      }
      return data.session === null ? 'confirmation_required' : 'signed_in';
    },

    async signInWithPassword({ email, password }): Promise<void> {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error !== null) {
        if (error.code === 'invalid_credentials') {
          throw new InvalidCredentialsError();
        }
        throw providerError(error);
      }
    },

    async sendMagicLink(email: string): Promise<void> {
      const { error } = await client.auth.signInWithOtp({ email });
      if (error !== null) {
        throw providerError(error);
      }
    },

    async verifyEmailToken({ tokenHash, type }): Promise<void> {
      const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error !== null) {
        throw new InvalidTokenError();
      }
    },

    async signOut(): Promise<void> {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error !== null) {
        throw providerError(error);
      }
    },
  };
}

function fromUser(user: User): { id: string; email: unknown; emailVerified: boolean } {
  return {
    id: user.id,
    email: user.email,
    emailVerified: typeof user.email_confirmed_at === 'string',
  };
}

/** A session whose claims do not describe an email user is treated as signed out. */
function toUser(candidate: {
  id: unknown;
  email: unknown;
  emailVerified: boolean;
}): AuthenticatedUser | null {
  const result = authenticatedUserSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/** Never forwards the provider's message verbatim to users; the code is enough to act on. */
function providerError(error: AuthError): AuthProviderError {
  const code = error.code ?? `status_${String(error.status ?? 'unknown')}`;
  switch (code) {
    case 'user_already_exists':
    case 'email_exists':
      return new AuthProviderError(
        code,
        'An account with this email already exists. Sign in instead.',
      );
    case 'weak_password':
      return new AuthProviderError(code, 'Choose a longer password.');
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return new AuthProviderError(code, 'Too many attempts. Try again in a minute.');
    case 'email_not_confirmed':
      return new AuthProviderError(code, 'Confirm your email address first; check your inbox.');
    default:
      return new AuthProviderError(code, 'Sign-in is unavailable right now. Try again shortly.');
  }
}
