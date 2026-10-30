import { desc, eq } from 'drizzle-orm';

import { auditLogs } from '../schema';
import { type TenantTx } from '../tenant-tx';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AuditEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: Date;
}

export interface NewAuditEntry {
  /** Dotted, lowercase, e.g. `tenant.created`, `feature_flag.updated`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

/** Append-only: runtime roles hold INSERT and SELECT only, so there is no update or delete here. */
export const auditLogsRepository = {
  async append(tx: TenantTx, entry: NewAuditEntry): Promise<AuditEntry> {
    const [row] = await tx.db
      .insert(auditLogs)
      .values({
        tenantId: tx.ctx.tenantId,
        actorKind: tx.ctx.actorKind,
        actorId: tx.ctx.actorId,
        requestId: tx.ctx.requestId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
      })
      .returning();
    if (row === undefined) {
      throw new Error('audit_logs insert returned no row');
    }
    return row;
  },

  listRecent(tx: TenantTx, limit = 50): Promise<AuditEntry[]> {
    return tx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tx.ctx.tenantId))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);
  },
};
