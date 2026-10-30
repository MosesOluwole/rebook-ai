import { AsyncLocalStorage } from 'node:async_hooks';

import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { type RuntimeRole } from '../domain/runtime-role';
import { parseTenantContext, type TenantContext } from '../domain/tenant-context';

/** The Drizzle transaction handle for the postgres.js driver. */
export type DbTransaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

declare const tenantTxBrand: unique symbol;

/**
 * A transaction that has a tenant context installed and runs as a runtime role.
 * Only `withTenant`/`withWorkerTenant` can create one (the brand is not exported), so a
 * repository that requires a TenantTx cannot be called with a bare database handle.
 */
export interface TenantTx {
  readonly [tenantTxBrand]: true;
  readonly db: DbTransaction;
  readonly ctx: TenantContext;
  readonly role: RuntimeRole;
}

export type TenantWork<T> = (tx: TenantTx) => Promise<T>;

/**
 * Runs work inside one tenant-scoped transaction. Calls do not nest: a `withTenant` inside
 * another's work would open a second transaction on another pooled connection, so it throws
 * `NestedTenantTransactionError` instead. Pass the outer `TenantTx` down.
 */
export interface TenantRunner {
  /** Runs `work` in one transaction as `rebook_app` with the tenant context installed. */
  withTenant<T>(ctx: unknown, work: TenantWork<T>): Promise<T>;
  /** The same for background jobs, as `rebook_worker`. */
  withWorkerTenant<T>(ctx: unknown, work: TenantWork<T>): Promise<T>;
}

export class NestedTenantTransactionError extends Error {
  constructor() {
    super(
      'withTenant cannot be nested: reuse the TenantTx of the enclosing transaction instead of opening another one',
    );
    this.name = 'NestedTenantTransactionError';
  }
}

const activeContext = new AsyncLocalStorage<TenantContext>();

export function createTenantRunner(db: PostgresJsDatabase): TenantRunner {
  return {
    withTenant: (ctx, work) => runAs(db, 'rebook_app', ctx, work),
    withWorkerTenant: (ctx, work) => runAs(db, 'rebook_worker', ctx, work),
  };
}

async function runAs<T>(
  db: PostgresJsDatabase,
  role: RuntimeRole,
  rawCtx: unknown,
  work: TenantWork<T>,
): Promise<T> {
  // Validate before touching the database: a bad context never opens a transaction.
  const ctx = parseTenantContext(rawCtx);
  if (activeContext.getStore() !== undefined) {
    throw new NestedTenantTransactionError();
  }

  return activeContext.run(ctx, () =>
    db.transaction(async (tx) => {
      // SET LOCAL cannot take bind parameters; the role name comes from a closed union and is
      // quoted as an identifier. set_config(..., true) is transaction-local and takes parameters.
      await tx.execute(sql`set local role ${sql.identifier(role)}`);
      await tx.execute(sql`
        select
          set_config('app.tenant_id', ${ctx.tenantId}, true),
          set_config('app.actor_id', ${ctx.actorId ?? ''}, true),
          set_config('app.actor_kind', ${ctx.actorKind}, true),
          set_config('app.request_id', ${ctx.requestId}, true)
      `);
      const handle = { db: tx, ctx, role } as TenantTx;
      return work(handle);
    }),
  );
}
