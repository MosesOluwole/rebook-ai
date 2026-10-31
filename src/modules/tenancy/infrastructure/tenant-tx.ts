import { AsyncLocalStorage } from 'node:async_hooks';

import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { type ActorKind } from '../domain/actor';
import { type MembershipRole } from '../domain/permissions';
import { type RuntimeRole } from '../domain/runtime-role';
import { parseTenantContext, type TenantContext } from '../domain/tenant-context';
import { parseRequestId } from '../domain/tenant-context';
import { type AuthenticatedUser, parseUserActor, type UserActor } from '../domain/user';
import { redactQueryParams } from './sql-errors';

/** The Drizzle transaction handle for the postgres.js driver. */
export type DbTransaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

declare const tenantTxBrand: unique symbol;
declare const userTxBrand: unique symbol;
declare const anonymousTxBrand: unique symbol;
declare const authorisedBrand: unique symbol;

/**
 * A tenant context for actors that are not signed-in users: public visitors, customers holding
 * a token, background jobs and the system itself. A plain object is enough because nothing about
 * these actors is proven by a membership.
 */
export interface UnauthenticatedTenantContext {
  readonly tenantId: string;
  readonly actorKind: Exclude<ActorKind, 'user'>;
  readonly actorId: string | null;
  readonly requestId: string;
}

export type AuthorisationGrant = 'membership' | 'registration' | 'invitation';

/**
 * A signed-in user's right to act inside one tenant (docs/adr/ADR-004-auth-sessions.md). Only
 * this module can create one: `resolveTenantForUser` proves an active membership; onboarding and
 * invite acceptance mint one for the single transaction in which the tenant or the membership
 * comes into existence. The brand is not exported, so `withTenant` cannot be handed a user
 * context assembled from a URL or a form.
 */
export interface AuthorisedTenantContext {
  readonly [authorisedBrand]: true;
  readonly tenantId: string;
  readonly actorKind: 'user';
  readonly actorId: string;
  readonly requestId: string;
  readonly user: AuthenticatedUser;
  /** The user's role in the tenant; null while registering or accepting an invitation. */
  readonly role: MembershipRole | null;
  readonly grant: AuthorisationGrant;
}

export type TenantContextInput = UnauthenticatedTenantContext | AuthorisedTenantContext;

/**
 * A transaction that has a tenant context installed and runs as a runtime role. Only
 * `withTenant`/`withWorkerTenant` can create one (the brand is not exported), so a repository
 * that requires a TenantTx cannot be called with a bare database handle.
 */
export interface TenantTx {
  readonly [tenantTxBrand]: true;
  readonly db: DbTransaction;
  /** The validated settings installed in the transaction. */
  readonly ctx: TenantContext;
  /** The context as it was passed in, including the user and role for authorised contexts. */
  readonly context: TenantContextInput;
  readonly role: RuntimeRole;
}

/**
 * A transaction that knows who the user is but has no tenant: `app.tenant_id` is empty, so every
 * tenant policy fails closed and only the actor branch of the memberships policy (and the member
 * branch of the tenants policy) can match. The one repository that accepts it lists the user's
 * own memberships.
 */
export interface UserTx {
  readonly [userTxBrand]: true;
  readonly db: DbTransaction;
  readonly user: AuthenticatedUser;
  readonly requestId: string;
}

/**
 * A transaction with neither tenant nor user: `app.tenant_id` and `app.actor_id` are empty and
 * the actor kind is `anonymous`, so every tenant policy and every actor branch fails closed.
 * Only platform-level tables with their own policies are reachable (rate_limits today; the
 * slug resolver for public pages in Phase 5).
 */
export interface AnonymousTx {
  readonly [anonymousTxBrand]: true;
  readonly db: DbTransaction;
  readonly requestId: string;
}

export type TenantWork<T> = (tx: TenantTx) => Promise<T>;
export type UserWork<T> = (tx: UserTx) => Promise<T>;
export type AnonymousWork<T> = (tx: AnonymousTx) => Promise<T>;

/**
 * Opens tenant-scoped and user-scoped transactions. Calls do not nest: a runner call inside
 * another's work would open a second transaction on another pooled connection, so it throws
 * `NestedTenantTransactionError` instead. Pass the outer handle down.
 */
export interface TenantRunner {
  /**
   * Runs `work` in one transaction as `rebook_app` with the tenant context installed. User
   * actors must come as an `AuthorisedTenantContext`; a plain object is accepted only for the
   * other actor kinds.
   */
  withTenant<T>(ctx: TenantContextInput, work: TenantWork<T>): Promise<T>;
  /** The same for background jobs, as `rebook_worker`. Jobs never act as a user. */
  withWorkerTenant<T>(ctx: UnauthenticatedTenantContext, work: TenantWork<T>): Promise<T>;
  /** Runs `work` as `rebook_app` with only the actor installed, for a user who has not chosen a tenant. */
  withUserContext<T>(actor: UserActor, work: UserWork<T>): Promise<T>;
  /** Runs `work` as `rebook_app` with no tenant and no user, for platform-level tables only. */
  withAnonymousContext<T>(requestId: string, work: AnonymousWork<T>): Promise<T>;
}

export class NestedTenantTransactionError extends Error {
  constructor() {
    super(
      'withTenant/withUserContext cannot be nested: reuse the handle of the enclosing transaction instead of opening another one',
    );
    this.name = 'NestedTenantTransactionError';
  }
}

const active = new AsyncLocalStorage<true>();

export function createTenantRunner(db: PostgresJsDatabase): TenantRunner {
  return {
    withTenant: (ctx, work) => runAs(db, 'rebook_app', ctx, work),
    withWorkerTenant: (ctx, work) => runAs(db, 'rebook_worker', ctx, work),
    withUserContext: (actor, work) => runAsUser(db, actor, work),
    withAnonymousContext: (requestId, work) => runAnonymously(db, requestId, work),
  };
}

function guardNesting(): void {
  if (active.getStore() !== undefined) {
    throw new NestedTenantTransactionError();
  }
}

async function runAs<T>(
  db: PostgresJsDatabase,
  role: RuntimeRole,
  context: TenantContextInput,
  work: TenantWork<T>,
): Promise<T> {
  // Validate before touching the database: a bad context never opens a transaction. Only the
  // four settings are validated; the user, role and grant of an authorised context ride along.
  const ctx = parseTenantContext({
    tenantId: context.tenantId,
    actorKind: context.actorKind,
    actorId: context.actorId,
    requestId: context.requestId,
  });
  guardNesting();

  return active.run(true, () =>
    db
      .transaction(async (tx) => {
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
        const handle = { db: tx, ctx, context, role } as TenantTx;
        return work(handle);
      })
      .catch((error: unknown) => {
        throw redactQueryParams(error);
      }),
  );
}

async function runAsUser<T>(
  db: PostgresJsDatabase,
  rawActor: UserActor,
  work: UserWork<T>,
): Promise<T> {
  const actor = parseUserActor(rawActor);
  guardNesting();

  return active.run(true, () =>
    db
      .transaction(async (tx) => {
        await tx.execute(sql`set local role rebook_app`);
        // app.tenant_id is set to '' on purpose, not left alone: on a pooled connection a value
        // from an earlier transaction must never be inherited.
        await tx.execute(sql`
          select
            set_config('app.tenant_id', '', true),
            set_config('app.actor_id', ${actor.user.id}, true),
            set_config('app.actor_kind', 'user', true),
            set_config('app.request_id', ${actor.requestId}, true)
        `);
        const handle = { db: tx, user: actor.user, requestId: actor.requestId } as UserTx;
        return work(handle);
      })
      .catch((error: unknown) => {
        throw redactQueryParams(error);
      }),
  );
}

async function runAnonymously<T>(
  db: PostgresJsDatabase,
  rawRequestId: string,
  work: AnonymousWork<T>,
): Promise<T> {
  const requestId = parseRequestId(rawRequestId);
  guardNesting();

  return active.run(true, () =>
    db
      .transaction(async (tx) => {
        await tx.execute(sql`set local role rebook_app`);
        await tx.execute(sql`
          select
            set_config('app.tenant_id', '', true),
            set_config('app.actor_id', '', true),
            set_config('app.actor_kind', 'anonymous', true),
            set_config('app.request_id', ${requestId}, true)
        `);
        const handle = { db: tx, requestId } as AnonymousTx;
        return work(handle);
      })
      .catch((error: unknown) => {
        throw redactQueryParams(error);
      }),
  );
}
