import { NextResponse } from 'next/server';

import { actorFor, currentUser } from '../../_lib/session';
import { getTenancy } from '../../_lib/tenancy';

export const dynamic = 'force-dynamic';

/** The signed-in user and the businesses they may switch to. 401 when signed out. */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (user === null) {
    return NextResponse.json(
      { error: 'unauthenticated' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  const tenants = await getTenancy().listMyTenants(actorFor(user));
  return NextResponse.json(
    { user: { id: user.id, email: user.email }, tenants },
    { headers: { 'cache-control': 'no-store' } },
  );
}
