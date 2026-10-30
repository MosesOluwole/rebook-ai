/**
 * Postgres roles entered with `SET LOCAL ROLE` inside a tenant transaction. Both are NOLOGIN and
 * NOBYPASSRLS; `rebook_authenticator` (the login role) is a member of each.
 */
export const RUNTIME_ROLES = ['rebook_app', 'rebook_worker'] as const;

export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
