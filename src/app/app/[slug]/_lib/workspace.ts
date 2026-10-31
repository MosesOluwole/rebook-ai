import { notFound } from 'next/navigation';
import { cache } from 'react';

import {
  type AuthorisedTenantContext,
  getCurrentTenant,
  type MyTenant,
  type Tenant,
} from '@/modules/tenancy';

import { isNotFound } from '../../../_lib/form-errors';
import { actorFor, requireUser } from '../../../_lib/session';
import { getTenancy } from '../../../_lib/tenancy';

export interface Workspace {
  readonly ctx: AuthorisedTenantContext;
  readonly tenant: Tenant;
  readonly myTenants: readonly MyTenant[];
}

/**
 * Everything a back-office page needs, resolved once per request and slug: the signed-in user
 * (or a redirect to sign-in), their authorised context for this slug (or 404, identical for an
 * unknown slug and a tenant they do not belong to), the tenant row and the switcher list.
 */
export const loadWorkspace = cache(async (slug: string): Promise<Workspace> => {
  const user = await requireUser(`/app/${slug}`);
  const tenancy = getTenancy();
  const actor = actorFor(user);
  let ctx: AuthorisedTenantContext;
  try {
    ctx = await tenancy.resolveTenantForUser(slug, actor);
  } catch (error) {
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
  const [tenant, myTenants] = await Promise.all([
    tenancy.withTenant(ctx, (tx) => getCurrentTenant(tx)),
    tenancy.listMyTenants(actor),
  ]);
  return { ctx, tenant, myTenants };
});

/** Re-authorises a server action for its slug; actions never trust the form's tenant. */
export async function authoriseAction(slug: string): Promise<AuthorisedTenantContext> {
  const user = await requireUser(`/app/${slug}`);
  try {
    return await getTenancy().resolveTenantForUser(slug, actorFor(user));
  } catch (error) {
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
}
