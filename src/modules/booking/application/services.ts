import {
  assertPermission,
  requireId,
  NotFoundError,
  type TenantTx,
  tenantsRepository,
} from '@/modules/tenancy';

import { parseServiceInput, serviceDefaultsFor, type ServiceDefaults } from '../domain/service';
import { type Service, servicesRepository } from '../infrastructure/repositories';

export type { Service };

/** The defaults a new-service form starts from, for the current tenant's business type. */
export async function newServiceDefaults(tx: TenantTx): Promise<ServiceDefaults> {
  assertPermission(tx, 'workspace.view');
  const tenant = await tenantsRepository.findCurrent(tx);
  if (tenant === null) {
    throw new NotFoundError();
  }
  return serviceDefaultsFor(tenant.businessType);
}

/**
 * Owner-only. Creates an unpublished service; mode and location type default from the business
 * type. The tenant row is share-locked first: a business type change in flight either finishes
 * before this service is created (and its defaults apply) or waits and then refuses, because a
 * service now exists (docs/phases.md Phase 3).
 */
export async function createService(tx: TenantTx, input: unknown): Promise<Service> {
  assertPermission(tx, 'services.manage');
  const tenant = await tenantsRepository.lockCurrent(tx, 'share');
  if (tenant === null) {
    throw new NotFoundError();
  }
  const service = parseServiceInput(input, serviceDefaultsFor(tenant.businessType));
  return servicesRepository.insert(tx, service);
}

/** Owner-only. Fields left out keep their stored values (mode, location type, published). */
export async function updateService(tx: TenantTx, id: string, input: unknown): Promise<Service> {
  assertPermission(tx, 'services.manage');
  const existing = await servicesRepository.findById(tx, requireId(id));
  if (existing === null) {
    throw new NotFoundError();
  }
  const service = parseServiceInput(input, existing);
  const updated = await servicesRepository.update(tx, id, service);
  if (updated === null) {
    throw new NotFoundError();
  }
  return updated;
}

/**
 * Owner-only. Unpublishing hides the service from public reads (RLS on rebook.services for
 * anonymous and customer actors) and changes nothing else: eligibility, custom field values and,
 * from Phase 4, bookings that reference it stay as they are.
 */
export async function setServicePublished(
  tx: TenantTx,
  id: string,
  published: boolean,
): Promise<Service> {
  assertPermission(tx, 'services.manage');
  const updated = await servicesRepository.setPublished(tx, requireId(id), published);
  if (updated === null) {
    throw new NotFoundError();
  }
  return updated;
}

/**
 * Owner-only. Deletes a service with its eligibility and custom field values. From Phase 4 a
 * service that has bookings cannot be deleted (the bookings' foreign key); unpublish it instead.
 */
export async function deleteService(tx: TenantTx, id: string): Promise<void> {
  assertPermission(tx, 'services.manage');
  if (!(await servicesRepository.delete(tx, requireId(id)))) {
    throw new NotFoundError();
  }
}

/** Every service, published or not, for any member. */
export function listServices(tx: TenantTx): Promise<Service[]> {
  assertPermission(tx, 'workspace.view');
  return servicesRepository.list(tx);
}

export async function getService(tx: TenantTx, id: string): Promise<Service> {
  assertPermission(tx, 'workspace.view');
  const service = await servicesRepository.findById(tx, requireId(id));
  if (service === null) {
    throw new NotFoundError();
  }
  return service;
}

/**
 * The public read path (booking pages from Phase 5): published services only. Not a command and
 * open to any actor; for anonymous and customer actors RLS hides unpublished services as well, so
 * a later query that forgets the filter still cannot show one.
 */
export function listPublishedServices(tx: TenantTx): Promise<Service[]> {
  return servicesRepository.listPublished(tx);
}

/**
 * Whether the current tenant has any service. The settings guard for business type changes
 * (`BusinessTypeGuard` in tenancy); it runs inside a command that has already checked permission.
 */
export function tenantHasServices(tx: TenantTx): Promise<boolean> {
  return servicesRepository.any(tx);
}
