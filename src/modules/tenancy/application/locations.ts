import { type Location, locationsRepository } from '../infrastructure/repositories/locations';
import { type TenantTx } from '../infrastructure/tenant-tx';
import { assertPermission } from './permissions-guard';

/** The tenant's locations, oldest (the default one from onboarding) first. Any member. */
export function listLocations(tx: TenantTx): Promise<Location[]> {
  assertPermission(tx, 'workspace.view');
  return locationsRepository.list(tx);
}
