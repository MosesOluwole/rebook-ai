/**
 * The login role the app connects as (docs/adr/ADR-002-schema-roles-context.md §2). Supabase's
 * transaction pooler (Supavisor) routes by username and expects `<role>.<project-ref>`, so
 * APP_DATABASE_URL carries either the bare role (direct connections, the local stack) or the
 * pooler form. Only the role part is compared; anything else is refused.
 */
export const AUTHENTICATOR_ROLE = 'rebook_authenticator';

/** Supabase project refs are lower-case letters and digits (20 today; the length is not assumed). */
const PROJECT_REF = /^[a-z0-9]+$/;

export type AuthenticatorUsername =
  | {
      readonly ok: true;
      readonly role: typeof AUTHENTICATOR_ROLE;
      readonly projectRef: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** Parses the (already percent-decoded) username of APP_DATABASE_URL. */
export function parseAuthenticatorUsername(username: string): AuthenticatorUsername {
  const dot = username.indexOf('.');
  const role = dot === -1 ? username : username.slice(0, dot);
  const projectRef = dot === -1 ? null : username.slice(dot + 1);
  if (role !== AUTHENTICATOR_ROLE) {
    return {
      ok: false,
      reason: `APP_DATABASE_URL must connect as ${AUTHENTICATOR_ROLE} or ${AUTHENTICATOR_ROLE}.<project-ref>, not '${username}'`,
    };
  }
  if (projectRef !== null && !PROJECT_REF.test(projectRef)) {
    return {
      ok: false,
      reason: `the project ref after '${AUTHENTICATOR_ROLE}.' must be lower-case letters and digits`,
    };
  }
  return { ok: true, role: AUTHENTICATOR_ROLE, projectRef };
}
