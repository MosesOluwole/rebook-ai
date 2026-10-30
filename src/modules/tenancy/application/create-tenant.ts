import { type IdGenerator } from '@/shared/kernel/ids';

import { type ActorKind } from '../domain/actor';
import { parseNewTenant, type Tenant } from '../domain/tenant';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { tenantsRepository } from '../infrastructure/repositories/tenants';
import { type TenantRunner } from '../infrastructure/tenant-tx';

export interface CreateTenantDeps {
  readonly runner: Pick<TenantRunner, 'withTenant'>;
  readonly ids: IdGenerator;
}

export interface Caller {
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly requestId: string;
}

/**
 * Creates a tenant. The tenants policy only admits rows whose id is the current tenant, so the
 * id is generated first, the context opened with it, and the row inserted inside that context,
 * together with the first audit entry.
 */
export async function createTenant(
  deps: CreateTenantDeps,
  input: unknown,
  caller: Caller,
): Promise<Tenant> {
  const tenant = parseNewTenant(input);
  const id = deps.ids.newId();

  return deps.runner.withTenant(
    {
      tenantId: id,
      actorKind: caller.actorKind,
      actorId: caller.actorId,
      requestId: caller.requestId,
    },
    async (tx) => {
      const created = await tenantsRepository.insert(tx, { id, ...tenant });
      await auditLogsRepository.append(tx, {
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: id,
        after: { name: created.name, slug: created.slug, timeZone: created.timeZone },
      });
      return created;
    },
  );
}
