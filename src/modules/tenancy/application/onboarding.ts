import { type IdGenerator } from '@/shared/kernel/ids';

import { SlugUnavailableError } from '../domain/errors';
import { slugify, slugWithSuffix } from '../domain/slug';
import { parseTenantSettings, type Tenant } from '../domain/tenant';
import { type UserActor } from '../domain/user';
import { authoriseRegistration } from '../infrastructure/authorised-context';
import { auditLogsRepository } from '../infrastructure/repositories/audit-logs';
import { locationsRepository } from '../infrastructure/repositories/locations';
import { membershipsRepository } from '../infrastructure/repositories/memberships';
import { tenantsRepository } from '../infrastructure/repositories/tenants';
import { sqlStateOf, UNIQUE_VIOLATION, violatedConstraintOf } from '../infrastructure/sql-errors';
import { type Membership } from '../infrastructure/repositories/memberships';
import { type TenantRunner, type TenantTx } from '../infrastructure/tenant-tx';

/**
 * What the rest of the system does when a business is created. Tenancy cannot import booking
 * (booking depends on tenancy), so the composition root supplies it: booking's
 * `onboardingHooks` adds the owner as the first team member (docs/phases.md Phase 3 decisions).
 * Runs inside the onboarding transaction, so a failure leaves nothing behind.
 */
export interface OnboardingHooks {
  ownerJoined(
    tx: TenantTx,
    joined: { readonly tenant: Tenant; readonly membership: Membership },
  ): Promise<void>;
}

export interface OnboardingDeps {
  readonly runner: Pick<TenantRunner, 'withTenant'>;
  readonly ids: IdGenerator;
  /** Random suffix for slug collisions; injected so tests can make collisions deterministic. */
  readonly slugSuffix: () => string;
  readonly hooks: OnboardingHooks;
}

const SLUG_ATTEMPTS = 5;

/**
 * Creates a business for a signed-in user who has none yet (docs/phases.md Phase 2): tenant,
 * default location, owner membership and (through `hooks.ownerJoined`) the owner's team member
 * in ONE transaction, with an app-generated tenant id and
 * the registration grant. The input is the same shape as the settings an owner can edit later.
 * A slug collision aborts the transaction (unique violation), so the whole thing is retried with
 * a suffixed slug and a fresh id; nothing partial is ever committed.
 */
export async function completeOnboarding(
  deps: OnboardingDeps,
  input: unknown,
  actor: UserActor,
): Promise<Tenant> {
  const settings = parseTenantSettings(input);
  const base = slugify(settings.name);

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : slugWithSuffix(base, deps.slugSuffix());
    const id = deps.ids.newId();
    try {
      return await deps.runner.withTenant(
        authoriseRegistration(actor.user, actor.requestId, id),
        async (tx) => {
          const tenant = await tenantsRepository.insert(tx, { id, slug, ...settings });
          const location = await locationsRepository.insert(tx, {
            name: settings.name,
            timeZone: settings.timeZone,
          });
          const membership = await membershipsRepository.insert(tx, {
            userId: actor.user.id,
            role: 'owner',
          });
          await auditLogsRepository.append(tx, {
            action: 'tenant.created',
            entityType: 'tenant',
            entityId: id,
            after: {
              name: tenant.name,
              slug: tenant.slug,
              businessType: tenant.businessType,
              timeZone: tenant.timeZone,
              defaultLocationId: location.id,
            },
          });
          await auditLogsRepository.append(tx, {
            action: 'membership.created',
            entityType: 'tenant_membership',
            entityId: membership.id,
            after: { role: membership.role, via: 'registration' },
          });
          await deps.hooks.ownerJoined(tx, { tenant, membership });
          return tenant;
        },
      );
    } catch (error) {
      const slugTaken =
        sqlStateOf(error) === UNIQUE_VIOLATION &&
        violatedConstraintOf(error) === 'tenants_slug_unique';
      if (!slugTaken) {
        throw error;
      }
    }
  }
  throw new SlugUnavailableError(base);
}
