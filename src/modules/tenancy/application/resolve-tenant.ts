import { NotFoundError } from '../domain/errors';
import { isSlug } from '../domain/slug';
import { type UserActor } from '../domain/user';
import { authoriseByMembership } from '../infrastructure/authorised-context';
import { myMembershipsRepository } from '../infrastructure/repositories/my-memberships';
import { tenantSlugsRepository } from '../infrastructure/repositories/tenant-slugs';
import { type AuthorisedTenantContext, type TenantRunner } from '../infrastructure/tenant-tx';

export interface ResolveTenantDeps {
  readonly runner: Pick<TenantRunner, 'withUserContext'>;
}

/** Never a real tenant; used so a miss does the same work as a hit. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Turns a URL slug into the signed-in user's right to act in that tenant
 * (docs/architecture.md §4: tenant from the slug, checked against an active membership, never from
 * a header or body). An unknown slug and a tenant the user is not a member of produce the same
 * NotFoundError, and both paths run the same two queries.
 */
export async function resolveTenantForUser(
  deps: ResolveTenantDeps,
  slug: string,
  actor: UserActor,
): Promise<AuthorisedTenantContext> {
  if (!isSlug(slug)) {
    throw new NotFoundError();
  }
  return deps.runner.withUserContext(actor, async (tx) => {
    const tenantId = await tenantSlugsRepository.resolve(tx, slug);
    const role = await myMembershipsRepository.findActiveRole(tx, tenantId ?? NIL_UUID);
    if (tenantId === null || role === null) {
      throw new NotFoundError();
    }
    return authoriseByMembership(tx.user, tx.requestId, tenantId, role);
  });
}
