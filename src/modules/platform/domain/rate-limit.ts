/**
 * Fixed-window rate limiting rules (docs/architecture.md §10 and §12, docs/adr/ADR-004 §9).
 * Pure: the counters live in `rebook.rate_limits`, reached through the platform module's
 * application layer. Each authentication flow is limited twice, per client IP and per
 * normalised email, and either limit refuses the attempt with the same generic message, so a
 * caller learns nothing about whether the address exists.
 */
export const AUTH_RATE_LIMIT_SCOPES = [
  'sign_in',
  'sign_up',
  'magic_link',
  'invite_accept',
] as const;

export type AuthRateLimitScope = (typeof AUTH_RATE_LIMIT_SCOPES)[number];

export interface RateLimitRule {
  /** Hits allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AuthRateLimitRules {
  readonly ip: RateLimitRule;
  readonly email: RateLimitRule;
}

const TEN_MINUTES = 600;
const ONE_HOUR = 3600;

export const AUTH_RATE_LIMITS: Readonly<Record<AuthRateLimitScope, AuthRateLimitRules>> = {
  sign_in: {
    ip: { limit: 20, windowSeconds: TEN_MINUTES },
    email: { limit: 5, windowSeconds: TEN_MINUTES },
  },
  sign_up: {
    ip: { limit: 20, windowSeconds: ONE_HOUR },
    email: { limit: 3, windowSeconds: ONE_HOUR },
  },
  magic_link: {
    ip: { limit: 10, windowSeconds: TEN_MINUTES },
    email: { limit: 3, windowSeconds: TEN_MINUTES },
  },
  invite_accept: {
    ip: { limit: 30, windowSeconds: TEN_MINUTES },
    email: { limit: 10, windowSeconds: TEN_MINUTES },
  },
};

export type RateLimitKind = keyof AuthRateLimitRules;

/** Addresses are compared case-insensitively and without surrounding whitespace. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** What gets hashed into a counter key. Never stored or logged in this form. */
export function rateLimitSubject(
  scope: AuthRateLimitScope,
  kind: RateLimitKind,
  value: string,
): string {
  return `${scope}:${kind}:${value}`;
}

/** The start of the fixed window containing `at`, as the database computes it. */
export function windowStart(at: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/** Seconds until the window containing `at` ends. */
export function secondsUntilWindowEnd(at: Date, windowSeconds: number): number {
  const end = windowStart(at, windowSeconds).getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - at.getTime()) / 1000));
}

/** Too many attempts in the current window. The message is the same for every key and scope. */
export class RateLimitedError extends Error {
  static readonly kind = 'RateLimitedError' as const;
  readonly kind = RateLimitedError.kind;
  readonly scope: AuthRateLimitScope;
  readonly retryAfterSeconds: number;

  constructor(scope: AuthRateLimitScope, retryAfterSeconds: number) {
    super('Too many attempts. Try again in a few minutes.');
    this.name = 'RateLimitedError';
    this.scope = scope;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
