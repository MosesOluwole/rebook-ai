import {
  assertPermission,
  requireId,
  FOREIGN_KEY_VIOLATION,
  type Membership,
  membershipsRepository,
  NotFoundError,
  type OnboardingHooks,
  PermissionDeniedError,
  sqlStateOf,
  type Tenant,
  type TenantTx,
  UNIQUE_VIOLATION,
  ValidationError,
  violatedConstraintOf,
} from '@/modules/tenancy';

import {
  parseDailyCapacityInput,
  parseServiceAreasInput,
  parseStaffServicesInput,
  parseTeamMemberInput,
  type TeamMemberInput,
} from '../domain/team';
import {
  dailyCapacityRepository,
  type DailyCapacityRule,
  serviceAreasRepository,
  servicesRepository,
  staffServicesRepository,
  type TeamMember,
  teamMembersRepository,
} from '../infrastructure/repositories';

export type { DailyCapacityRule, TeamMember };

const LINKED_ELSEWHERE = 'already linked to another team member';

/** A membership may be linked only while it is active, and only once per tenant. */
async function checkMembership(tx: TenantTx, input: TeamMemberInput, self: string | null) {
  if (input.membershipId === null) {
    return;
  }
  const membership = await membershipsRepository.findById(tx, input.membershipId);
  if (membership?.revokedAt !== null) {
    throw new NotFoundError();
  }
  const linked = (await teamMembersRepository.list(tx)).find(
    (member) => member.membershipId === input.membershipId && member.id !== self,
  );
  if (linked !== undefined) {
    throw new ValidationError('team member', [`membershipId: ${LINKED_ELSEWHERE}`], {
      membershipId: [LINKED_ELSEWHERE],
    });
  }
}

/** Maps the unique (tenant_id, membership_id) race to the same field error as the pre-check. */
function linkedElsewhere(error: unknown): never {
  if (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    violatedConstraintOf(error) === 'team_members_tenant_id_membership_id_unique'
  ) {
    throw new ValidationError('team member', [`membershipId: ${LINKED_ELSEWHERE}`], {
      membershipId: [LINKED_ELSEWHERE],
    });
  }
  throw error;
}

/** Owner-only. A team member, optionally linked to an active membership of this tenant. */
export async function createTeamMember(tx: TenantTx, input: unknown): Promise<TeamMember> {
  assertPermission(tx, 'team.manage');
  const member = parseTeamMemberInput(input);
  await checkMembership(tx, member, null);
  try {
    return await teamMembersRepository.insert(tx, member);
  } catch (error) {
    return linkedElsewhere(error);
  }
}

export async function updateTeamMember(
  tx: TenantTx,
  id: string,
  input: unknown,
): Promise<TeamMember> {
  assertPermission(tx, 'team.manage');
  const member = parseTeamMemberInput(input);
  if ((await teamMembersRepository.lock(tx, requireId(id))) === null) {
    throw new NotFoundError();
  }
  await checkMembership(tx, member, id);
  try {
    const updated = await teamMembersRepository.update(tx, id, member);
    if (updated === null) {
      throw new NotFoundError();
    }
    return updated;
  } catch (error) {
    return linkedElsewhere(error);
  }
}

/** Owner-only. An inactive team member keeps their configuration but is offered for nothing. */
export async function setTeamMemberActive(
  tx: TenantTx,
  id: string,
  active: boolean,
): Promise<TeamMember> {
  assertPermission(tx, 'team.manage');
  const updated = await teamMembersRepository.setActive(tx, requireId(id), active);
  if (updated === null) {
    throw new NotFoundError();
  }
  return updated;
}

export function listTeamMembers(tx: TenantTx): Promise<TeamMember[]> {
  assertPermission(tx, 'workspace.view');
  return teamMembersRepository.list(tx);
}

export async function getTeamMember(tx: TenantTx, id: string): Promise<TeamMember> {
  assertPermission(tx, 'workspace.view');
  const member = await teamMembersRepository.findById(tx, requireId(id));
  if (member === null) {
    throw new NotFoundError();
  }
  return member;
}

/**
 * Owner-only. Replaces the services a team member may deliver. Every id must be a service of this
 * tenant: an id from another tenant is a NotFoundError here, and the composite foreign key
 * (tenant_id, service_id) → services (tenant_id, id) refuses it in the database regardless.
 */
export async function setStaffServices(
  tx: TenantTx,
  teamMemberId: string,
  input: unknown,
): Promise<readonly string[]> {
  assertPermission(tx, 'team.manage');
  const serviceIds = parseStaffServicesInput(input);
  if ((await teamMembersRepository.lock(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  if ((await servicesRepository.countByIds(tx, serviceIds)) !== serviceIds.length) {
    throw new NotFoundError();
  }
  try {
    await staffServicesRepository.replaceForTeamMember(tx, teamMemberId, serviceIds);
  } catch (error) {
    if (sqlStateOf(error) === FOREIGN_KEY_VIOLATION) {
      throw new NotFoundError();
    }
    throw error;
  }
  return serviceIds;
}

export function staffServiceIds(tx: TenantTx, teamMemberId: string): Promise<string[]> {
  assertPermission(tx, 'workspace.view');
  return staffServicesRepository.serviceIdsFor(tx, requireId(teamMemberId));
}

export interface ServiceAreas {
  readonly districts: readonly string[];
  readonly travelBeforeMinutes: number;
  readonly travelAfterMinutes: number;
}

/** Owner-only. Postcode districts for home visits and the travel minutes around each visit. */
export async function setServiceAreas(
  tx: TenantTx,
  teamMemberId: string,
  input: unknown,
): Promise<ServiceAreas> {
  assertPermission(tx, 'team.manage');
  const areas = parseServiceAreasInput(input);
  if ((await teamMembersRepository.lock(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  await serviceAreasRepository.replace(tx, teamMemberId, areas.districts);
  await teamMembersRepository.setTravel(tx, teamMemberId, {
    travelBeforeMinutes: areas.travelBeforeMinutes,
    travelAfterMinutes: areas.travelAfterMinutes,
  });
  return areas;
}

export async function getServiceAreas(tx: TenantTx, teamMemberId: string): Promise<ServiceAreas> {
  assertPermission(tx, 'workspace.view');
  const member = await teamMembersRepository.findById(tx, requireId(teamMemberId));
  if (member === null) {
    throw new NotFoundError();
  }
  return {
    districts: await serviceAreasRepository.list(tx, teamMemberId),
    travelBeforeMinutes: member.travelBeforeMinutes,
    travelAfterMinutes: member.travelAfterMinutes,
  };
}

/**
 * Owner-only. Events per date for a team member's request-mode services. Stored and validated
 * only: nothing enforces it until Phase 7 creates per-date capacity rows from it.
 */
export async function setDailyCapacity(
  tx: TenantTx,
  teamMemberId: string,
  input: unknown,
): Promise<DailyCapacityRule> {
  assertPermission(tx, 'schedules.manage');
  const { maxEventsPerDate } = parseDailyCapacityInput(input);
  if ((await teamMembersRepository.lock(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  return dailyCapacityRepository.upsert(tx, teamMemberId, maxEventsPerDate);
}

export async function removeDailyCapacity(tx: TenantTx, teamMemberId: string): Promise<void> {
  assertPermission(tx, 'schedules.manage');
  if ((await teamMembersRepository.lock(tx, requireId(teamMemberId))) === null) {
    throw new NotFoundError();
  }
  await dailyCapacityRepository.remove(tx, teamMemberId);
}

export function getDailyCapacity(
  tx: TenantTx,
  teamMemberId: string,
): Promise<DailyCapacityRule | null> {
  assertPermission(tx, 'workspace.view');
  return dailyCapacityRepository.find(tx, requireId(teamMemberId));
}

/**
 * The owner of a new business is its first team member, linked to their membership (Phase 3
 * decisions). Called by tenancy's onboarding inside its own transaction through
 * `onboardingHooks`; not a user command, so instead of a permission it accepts only the
 * registration grant that onboarding holds. The display name starts as the business name (most
 * pilots are sole practitioners) and the owner can change it.
 */
export async function addOwnerAsTeamMember(
  tx: TenantTx,
  joined: { readonly tenant: Tenant; readonly membership: Membership },
): Promise<void> {
  const context = tx.context;
  if (context.actorKind !== 'user' || context.grant !== 'registration') {
    throw new PermissionDeniedError('none', 'team.manage');
  }
  await teamMembersRepository.insert(tx, {
    displayName: joined.tenant.name.trim().slice(0, 80).trim(),
    membershipId: joined.membership.id,
  });
}

export const onboardingHooks: OnboardingHooks = { ownerJoined: addOwnerAsTeamMember };
