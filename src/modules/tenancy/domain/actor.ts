/**
 * Who is acting inside a tenant context (docs/architecture.md §4).
 * user: a signed-in staff member; customer: a holder of a scoped token; anonymous: a public page
 * visitor; worker: a background job; system: the application itself (bootstrapping, migrations).
 */
export const ACTOR_KINDS = ['user', 'customer', 'anonymous', 'worker', 'system'] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];
