/**
 * Every typed error carries a `kind` literal (static and per instance) that the module owns.
 * `instanceof` is the primary check everywhere; the web layer may also compare `kind` because
 * the dev server's hot reload can leave two copies of a class alive. A literal survives
 * production minification, which mangles class names, so `name` is never used for routing.
 */
/** A caller supplied data that failed validation at a module boundary. */
export class ValidationError extends Error {
  static readonly kind = 'ValidationError' as const;
  readonly kind = ValidationError.kind;

  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super(`Invalid ${subject}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * The thing asked for does not exist for this caller. Deliberately carries no detail: a slug that
 * does not exist, a tenant the user is not a member of, and an invitation that is expired,
 * revoked, used or for someone else all produce exactly this error, so nothing leaks about which
 * it was (docs/architecture.md §4: cross-tenant requests return 404, no existence leak).
 */
export class NotFoundError extends Error {
  static readonly kind = 'NotFoundError' as const;
  readonly kind = NotFoundError.kind;

  constructor() {
    super('Not found');
    this.name = 'NotFoundError';
  }
}

/** A tenant feature flag required by the caller is off (or unset) for this tenant. */
export class FeatureDisabledError extends Error {
  static readonly kind = 'FeatureDisabledError' as const;
  readonly kind = FeatureDisabledError.kind;

  readonly flag: string;

  constructor(flag: string) {
    super(`Feature '${flag}' is not enabled for this tenant`);
    this.name = 'FeatureDisabledError';
    this.flag = flag;
  }
}

/**
 * Every slug candidate for a new tenant collided. The base is kept as a field, not in the
 * message: it derives from the business name, which may be a person's name, and messages end
 * up in URLs and logs.
 */
export class SlugUnavailableError extends Error {
  static readonly kind = 'SlugUnavailableError' as const;
  readonly kind = SlugUnavailableError.kind;

  readonly base: string;

  constructor(base: string) {
    super('That business name is taken in too many variants; try a different name');
    this.name = 'SlugUnavailableError';
    this.base = base;
  }
}

/** The signed-in user has not verified the email address an action depends on. */
export class EmailNotVerifiedError extends Error {
  static readonly kind = 'EmailNotVerifiedError' as const;
  readonly kind = EmailNotVerifiedError.kind;

  constructor() {
    super('Verify your email address first');
    this.name = 'EmailNotVerifiedError';
  }
}

/** An owner tried to remove their own membership, which would lock the business out. */
export class CannotRevokeSelfError extends Error {
  static readonly kind = 'CannotRevokeSelfError' as const;
  readonly kind = CannotRevokeSelfError.kind;

  constructor() {
    super('You cannot revoke your own membership');
    this.name = 'CannotRevokeSelfError';
  }
}

/** Sign-in with a password failed. The message never says whether the email exists. */
export class InvalidCredentialsError extends Error {
  static readonly kind = 'InvalidCredentialsError' as const;
  readonly kind = InvalidCredentialsError.kind;

  constructor() {
    super('Incorrect email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/** An email verification token (magic link, sign-up confirmation) was invalid or expired. */
export class InvalidTokenError extends Error {
  static readonly kind = 'InvalidTokenError' as const;
  readonly kind = InvalidTokenError.kind;

  constructor() {
    super('This link is invalid or has expired');
    this.name = 'InvalidTokenError';
  }
}

/** The authentication provider refused a request; `code` is its machine-readable reason. */
export class AuthProviderError extends Error {
  static readonly kind = 'AuthProviderError' as const;
  readonly kind = AuthProviderError.kind;

  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthProviderError';
    this.code = code;
  }
}

/** A business type change the health rules forbid (midwife → any non-health type). */
export class BusinessTypeChangeError extends Error {
  static readonly kind = 'BusinessTypeChangeError' as const;
  readonly kind = BusinessTypeChangeError.kind;

  constructor() {
    super(
      'A midwife business cannot be changed to another business type: its patients are protected by the health rules',
    );
    this.name = 'BusinessTypeChangeError';
  }
}

/** The address already has an open invitation in this tenant. */
export class DuplicateInvitationError extends Error {
  static readonly kind = 'DuplicateInvitationError' as const;
  readonly kind = DuplicateInvitationError.kind;

  constructor() {
    super('An invitation for this email address is already open; revoke it to send a new one');
    this.name = 'DuplicateInvitationError';
  }
}

/** The signed-in user is already an active member of the tenant an invitation points at. */
export class AlreadyMemberError extends Error {
  static readonly kind = 'AlreadyMemberError' as const;
  readonly kind = AlreadyMemberError.kind;

  constructor() {
    super('You are already a member of this business');
    this.name = 'AlreadyMemberError';
  }
}
