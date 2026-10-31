/**
 * Typed errors of the crm module. Each carries a `kind` literal (static and per instance), as in
 * tenancy's domain/errors.ts, so the web layer can match it even when hot reload duplicates the
 * class, and minification cannot rename it.
 */

/**
 * Health businesses keep no client-scoped custom fields in the MVP (data minimisation,
 * docs/phases.md Phase 3, ADR-005 §6). Service-scoped fields are unaffected.
 */
export class HealthClientFieldError extends Error {
  static readonly kind = 'HealthClientFieldError' as const;
  readonly kind = HealthClientFieldError.kind;

  constructor() {
    super(
      'Health businesses cannot add custom fields to client records. Service fields are still available.',
    );
    this.name = 'HealthClientFieldError';
  }
}
