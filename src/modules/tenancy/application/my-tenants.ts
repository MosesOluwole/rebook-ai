import { type UserActor } from '../domain/user';
import {
  myMembershipsRepository,
  type MyTenant,
} from '../infrastructure/repositories/my-memberships';
import { type TenantRunner } from '../infrastructure/tenant-tx';

export type { MyTenant };

/** The tenants a signed-in user may switch to: their active memberships, with names and slugs. */
export function listMyTenants(
  deps: { readonly runner: Pick<TenantRunner, 'withUserContext'> },
  actor: UserActor,
): Promise<MyTenant[]> {
  return deps.runner.withUserContext(actor, (tx) => myMembershipsRepository.listMine(tx));
}
