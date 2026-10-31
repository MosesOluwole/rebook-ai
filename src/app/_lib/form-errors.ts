import { HealthClientFieldError } from '@/modules/crm';
import {
  AlreadyMemberError,
  AuthProviderError,
  BusinessTypeChangeError,
  BusinessTypeLockedError,
  CannotRevokeSelfError,
  DuplicateInvitationError,
  EmailNotVerifiedError,
  FeatureDisabledError,
  HealthCustomFieldsError,
  InvalidCredentialsError,
  InvalidTokenError,
  NotFoundError,
  PermissionDeniedError,
  SlugUnavailableError,
  ValidationError,
} from '@/modules/tenancy';

/**
 * Is `error` one of the module's typed errors? `instanceof` first; otherwise the `kind` literal
 * every typed error carries (see domain/errors.ts). The second test exists because the dev
 * server's hot reload can leave two copies of a class alive (one in the route graph, one in the
 * module), and a 404 must not become a 500 because of that. `kind` is a literal the module owns,
 * so it survives production minification and cannot be matched by a foreign error that merely
 * shares a `name`. This helper is the only place that matching is allowed.
 */
export function isTypedError<T extends Error>(
  error: unknown,
  type: (new (...args: never[]) => T) & { readonly kind: string },
): error is T {
  return (
    error instanceof type ||
    (error instanceof Error && (error as { kind?: unknown }).kind === type.kind)
  );
}

export const isNotFound = (error: unknown): error is NotFoundError =>
  isTypedError(error, NotFoundError);

/**
 * Turns the module's typed errors into a sentence for a form. Anything else is rethrown: an
 * unexpected failure must surface, not become a friendly message. Nothing here echoes user input.
 */
export function formMessage(error: unknown): string {
  if (isTypedError(error, ValidationError)) {
    return `Check the form: ${error.issues.join('; ')}.`;
  }
  if (isTypedError(error, PermissionDeniedError)) {
    return 'Only an owner can do that.';
  }
  if (
    isTypedError(error, InvalidCredentialsError) ||
    isTypedError(error, InvalidTokenError) ||
    isTypedError(error, AuthProviderError) ||
    isTypedError(error, EmailNotVerifiedError) ||
    isTypedError(error, CannotRevokeSelfError) ||
    isTypedError(error, SlugUnavailableError) ||
    isTypedError(error, FeatureDisabledError) ||
    isTypedError(error, BusinessTypeChangeError) ||
    isTypedError(error, BusinessTypeLockedError) ||
    isTypedError(error, HealthCustomFieldsError) ||
    isTypedError(error, HealthClientFieldError) ||
    isTypedError(error, DuplicateInvitationError) ||
    isTypedError(error, AlreadyMemberError)
  ) {
    return error.message;
  }
  if (isNotFound(error)) {
    return 'Not found.';
  }
  throw error;
}

export function readString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === 'string' ? value : '';
}
