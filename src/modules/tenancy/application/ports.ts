import { type AuthenticatedUser } from '../domain/user';

/** Verification token types our confirm route accepts (a subset of Supabase's EmailOtpType). */
export const EMAIL_TOKEN_TYPES = [
  'magiclink',
  'signup',
  'email',
  'recovery',
  'email_change',
] as const;
export type EmailTokenType = (typeof EMAIL_TOKEN_TYPES)[number];

export type SignUpOutcome = 'signed_in' | 'confirmation_required';

/**
 * What the application needs from the authentication provider. Implemented by the Supabase
 * adapter in infrastructure; the application layer never sees Supabase types.
 */
export interface AuthGateway {
  /** The signed-in user from a verified token, or null. Cheap; call it on every request. */
  currentUser(): Promise<AuthenticatedUser | null>;
  /** The signed-in user fetched fresh from the provider, including whether the email is verified. */
  currentUserVerified(): Promise<AuthenticatedUser | null>;
  signUpWithPassword(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<SignUpOutcome>;
  signInWithPassword(input: { readonly email: string; readonly password: string }): Promise<void>;
  sendMagicLink(email: string): Promise<void>;
  verifyEmailToken(input: {
    readonly tokenHash: string;
    readonly type: EmailTokenType;
  }): Promise<void>;
  signOut(): Promise<void>;
}
