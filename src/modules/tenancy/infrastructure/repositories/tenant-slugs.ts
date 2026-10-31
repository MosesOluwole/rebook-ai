import { sql } from 'drizzle-orm';

import { type UserTx } from '../tenant-tx';

/**
 * Slug lookup through `rebook.resolve_tenant_slug()`, the SECURITY DEFINER function that returns
 * only a tenant id (docs/adr/ADR-004-auth-sessions.md). It is the one way to learn a tenant id
 * before a tenant context exists; whether the caller may enter that tenant is decided afterwards.
 */
export const tenantSlugsRepository = {
  async resolve(tx: UserTx, slug: string): Promise<string | null> {
    const rows = await tx.db.execute<{ id: string | null }>(
      sql`select rebook.resolve_tenant_slug(${slug}) as id`,
    );
    return rows[0]?.id ?? null;
  },
};
