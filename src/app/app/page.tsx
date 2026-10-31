import { redirect } from 'next/navigation';

import { actorFor, requireUser } from '../_lib/session';
import { getTenancy } from '../_lib/tenancy';

export const dynamic = 'force-dynamic';

/** `/app` has no content of its own: it sends the user to their first business, or to onboarding. */
export default async function WorkspaceIndex() {
  const user = await requireUser('/app');
  const tenants = await getTenancy().listMyTenants(actorFor(user));
  const [firstTenant] = tenants;
  redirect(firstTenant === undefined ? '/onboarding' : `/app/${firstTenant.slug}`);
}
