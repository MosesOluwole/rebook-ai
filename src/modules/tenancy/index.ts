/**
 * Tenancy module: the tenant context, the runtime roles and the core tenant-owned tables
 * (docs/architecture.md §4 and §5, docs/adr/ADR-002-schema-roles-context.md).
 *
 * Every query against tenant data runs through `withTenant` or `withWorkerTenant`, which open a
 * transaction as a NOBYPASSRLS role with the tenant context installed, and hand repositories a
 * branded `TenantTx`. Other modules reference these tables for composite foreign keys and call
 * the repositories; they never query `rebook` tables with a bare database handle.
 */
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { type Clock } from '@/shared/kernel/clock';

import { type Caller, createTenant, type CreateTenantDeps } from './application/create-tenant';
import { type Tenant } from './domain/tenant';
import { createTenantRunner, type TenantRunner, type TenantWork } from './infrastructure/tenant-tx';
import { createUuidV7Generator } from './infrastructure/uuid-v7-generator';

export { ACTOR_KINDS, type ActorKind } from './domain/actor';
export { ValidationError } from './domain/errors';
export { newLocationSchema, parseNewLocation } from './domain/location';
export { RUNTIME_ROLES, type RuntimeRole } from './domain/runtime-role';
export {
  newTenantSchema,
  parseNewTenant,
  SLUG_PATTERN,
  type NewTenant,
  type Tenant,
} from './domain/tenant';
export {
  parseTenantContext,
  TenantContextError,
  tenantContextSchema,
  type TenantContext,
} from './domain/tenant-context';
export { isIanaTimeZone } from './domain/time-zone';
export { type Caller, createTenant, type CreateTenantDeps } from './application/create-tenant';
export {
  auditLogsRepository,
  type AuditEntry,
  type NewAuditEntry,
} from './infrastructure/repositories/audit-logs';
export { isFeatureEnabled, setFeatureFlag } from './application/feature-flags';
export { featureFlagNameSchema, parseFeatureFlagName } from './domain/feature-flag';
export {
  locationsRepository,
  type Location,
  type NewLocation,
} from './infrastructure/repositories/locations';
export {
  membershipsRepository,
  type Membership,
  type MembershipRole,
  type NewMembership,
} from './infrastructure/repositories/memberships';
export { tenantsRepository } from './infrastructure/repositories/tenants';
// Table objects are exported so later modules can declare composite foreign keys
// (`foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] })`).
// Never query them directly: go through the repositories and application functions above.
export {
  auditLogs,
  idempotencyKeys,
  locations,
  rebook,
  tenantFeatureFlags,
  tenantMemberships,
  tenants,
} from './infrastructure/schema';
export {
  createTenantRunner,
  NestedTenantTransactionError,
  type DbTransaction,
  type TenantRunner,
  type TenantTx,
  type TenantWork,
} from './infrastructure/tenant-tx';
export { createUuidV7Generator } from './infrastructure/uuid-v7-generator';

export interface Tenancy {
  readonly runner: TenantRunner;
  readonly withTenant: TenantRunner['withTenant'];
  readonly withWorkerTenant: TenantRunner['withWorkerTenant'];
  createTenant(input: unknown, caller: Caller): Promise<Tenant>;
}

/** Composition root: wires the runner and id generator for a database connected as rebook_authenticator. */
export function createTenancy(db: PostgresJsDatabase, clock: Clock): Tenancy {
  const runner = createTenantRunner(db);
  const deps: CreateTenantDeps = { runner, ids: createUuidV7Generator(clock) };
  return {
    runner,
    withTenant: <T>(ctx: unknown, work: TenantWork<T>) => runner.withTenant(ctx, work),
    withWorkerTenant: <T>(ctx: unknown, work: TenantWork<T>) => runner.withWorkerTenant(ctx, work),
    createTenant: (input, caller) => createTenant(deps, input, caller),
  };
}
