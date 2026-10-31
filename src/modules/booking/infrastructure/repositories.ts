import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';

import { type TenantTx } from '@/modules/tenancy';

import { type ResolvedException } from '../domain/availability-exception';
import { type ServiceInput } from '../domain/service';
import { type TeamMemberInput } from '../domain/team';
import { formatTimeOfDay, type Weekday, type WorkingRange } from '../domain/working-hours';
import {
  availabilityExceptions,
  dailyCapacityRules,
  services,
  staffServices,
  teamMembers,
  teamMemberServiceAreas,
  workingHourBreaks,
  workingHours,
} from './schema';

/**
 * Repositories for the booking configuration tables. Every function takes the branded TenantTx,
 * so none can run outside `withTenant`; RLS scopes every statement to the current tenant, and
 * the explicit `tenant_id` filters keep the query plans on the (tenant_id, …) indexes.
 */

export type Service = typeof services.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type AvailabilityException = typeof availabilityExceptions.$inferSelect;
export type DailyCapacityRule = typeof dailyCapacityRules.$inferSelect;

function one<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`${what} returned no row`);
  }
  return row;
}

/** "09:00:00" (Postgres time) → minutes past midnight; "24:00:00" → 1440. */
function minutesOf(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export const servicesRepository = {
  async insert(tx: TenantTx, input: ServiceInput): Promise<Service> {
    const rows = await tx.db
      .insert(services)
      .values({ tenantId: tx.ctx.tenantId, ...input })
      .returning();
    return one(rows, 'services insert');
  },

  async update(tx: TenantTx, id: string, input: ServiceInput): Promise<Service | null> {
    const [row] = await tx.db
      .update(services)
      .set({ ...input, updatedAt: sql`now()` })
      .where(and(eq(services.tenantId, tx.ctx.tenantId), eq(services.id, id)))
      .returning();
    return row ?? null;
  },

  async setPublished(tx: TenantTx, id: string, published: boolean): Promise<Service | null> {
    const [row] = await tx.db
      .update(services)
      .set({ published, updatedAt: sql`now()` })
      .where(and(eq(services.tenantId, tx.ctx.tenantId), eq(services.id, id)))
      .returning();
    return row ?? null;
  },

  async delete(tx: TenantTx, id: string): Promise<boolean> {
    const rows = await tx.db
      .delete(services)
      .where(and(eq(services.tenantId, tx.ctx.tenantId), eq(services.id, id)))
      .returning({ id: services.id });
    return rows.length > 0;
  },

  async findById(tx: TenantTx, id: string): Promise<Service | null> {
    const [row] = await tx.db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tx.ctx.tenantId), eq(services.id, id)));
    return row ?? null;
  },

  /** Every service the caller may see: all of them for members; RLS hides unpublished ones from public actors. */
  list(tx: TenantTx): Promise<Service[]> {
    return tx.db
      .select()
      .from(services)
      .where(eq(services.tenantId, tx.ctx.tenantId))
      .orderBy(asc(services.name), asc(services.id));
  },

  listPublished(tx: TenantTx): Promise<Service[]> {
    return tx.db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tx.ctx.tenantId), eq(services.published, true)))
      .orderBy(asc(services.name), asc(services.id));
  },

  /** How many of `ids` are services of the current tenant (ids are distinct). */
  async countByIds(tx: TenantTx, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const rows = await tx.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tx.ctx.tenantId), inArray(services.id, [...ids])));
    return rows.length;
  },

  async any(tx: TenantTx): Promise<boolean> {
    const rows = await tx.db
      .select({ id: services.id })
      .from(services)
      .where(eq(services.tenantId, tx.ctx.tenantId))
      .limit(1);
    return rows.length > 0;
  },
};

export const teamMembersRepository = {
  async insert(tx: TenantTx, input: TeamMemberInput): Promise<TeamMember> {
    const rows = await tx.db
      .insert(teamMembers)
      .values({
        tenantId: tx.ctx.tenantId,
        displayName: input.displayName,
        membershipId: input.membershipId,
      })
      .returning();
    return one(rows, 'team_members insert');
  },

  async update(tx: TenantTx, id: string, input: TeamMemberInput): Promise<TeamMember | null> {
    const [row] = await tx.db
      .update(teamMembers)
      .set({
        displayName: input.displayName,
        membershipId: input.membershipId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(teamMembers.tenantId, tx.ctx.tenantId), eq(teamMembers.id, id)))
      .returning();
    return row ?? null;
  },

  async setActive(tx: TenantTx, id: string, active: boolean): Promise<TeamMember | null> {
    const [row] = await tx.db
      .update(teamMembers)
      .set({ active, updatedAt: sql`now()` })
      .where(and(eq(teamMembers.tenantId, tx.ctx.tenantId), eq(teamMembers.id, id)))
      .returning();
    return row ?? null;
  },

  async setTravel(
    tx: TenantTx,
    id: string,
    travel: { readonly travelBeforeMinutes: number; readonly travelAfterMinutes: number },
  ): Promise<TeamMember | null> {
    const [row] = await tx.db
      .update(teamMembers)
      .set({ ...travel, updatedAt: sql`now()` })
      .where(and(eq(teamMembers.tenantId, tx.ctx.tenantId), eq(teamMembers.id, id)))
      .returning();
    return row ?? null;
  },

  async findById(tx: TenantTx, id: string): Promise<TeamMember | null> {
    const [row] = await tx.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.tenantId, tx.ctx.tenantId), eq(teamMembers.id, id)));
    return row ?? null;
  },

  /**
   * Locks the team member's row until the transaction ends, so two edits of one person's
   * schedule run one after the other instead of interleaving their delete-and-insert.
   */
  async lock(tx: TenantTx, id: string): Promise<TeamMember | null> {
    const [row] = await tx.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.tenantId, tx.ctx.tenantId), eq(teamMembers.id, id)))
      .for('update');
    return row ?? null;
  },

  list(tx: TenantTx): Promise<TeamMember[]> {
    return tx.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.tenantId, tx.ctx.tenantId))
      .orderBy(asc(teamMembers.displayName), asc(teamMembers.id));
  },
};

export const staffServicesRepository = {
  async replaceForTeamMember(
    tx: TenantTx,
    teamMemberId: string,
    serviceIds: readonly string[],
  ): Promise<void> {
    await tx.db
      .delete(staffServices)
      .where(
        and(
          eq(staffServices.tenantId, tx.ctx.tenantId),
          eq(staffServices.teamMemberId, teamMemberId),
        ),
      );
    if (serviceIds.length > 0) {
      await tx.db.insert(staffServices).values(
        serviceIds.map((serviceId) => ({
          tenantId: tx.ctx.tenantId,
          teamMemberId,
          serviceId,
        })),
      );
    }
  },

  async serviceIdsFor(tx: TenantTx, teamMemberId: string): Promise<string[]> {
    const rows = await tx.db
      .select({ serviceId: staffServices.serviceId })
      .from(staffServices)
      .where(
        and(
          eq(staffServices.tenantId, tx.ctx.tenantId),
          eq(staffServices.teamMemberId, teamMemberId),
        ),
      );
    return rows.map((row) => row.serviceId);
  },

  async teamMemberIdsFor(tx: TenantTx, serviceId: string): Promise<string[]> {
    const rows = await tx.db
      .select({ teamMemberId: staffServices.teamMemberId })
      .from(staffServices)
      .where(
        and(eq(staffServices.tenantId, tx.ctx.tenantId), eq(staffServices.serviceId, serviceId)),
      );
    return rows.map((row) => row.teamMemberId);
  },
};

export interface StoredWorkingRange extends WorkingRange {
  readonly locationId: string;
}

export const workingHoursRepository = {
  /** Replaces one team member's weekly ranges (and their breaks) at one location. */
  async replace(
    tx: TenantTx,
    teamMemberId: string,
    locationId: string,
    ranges: readonly WorkingRange[],
  ): Promise<void> {
    await tx.db
      .delete(workingHours)
      .where(
        and(
          eq(workingHours.tenantId, tx.ctx.tenantId),
          eq(workingHours.teamMemberId, teamMemberId),
          eq(workingHours.locationId, locationId),
        ),
      );
    for (const range of ranges) {
      const [row] = await tx.db
        .insert(workingHours)
        .values({
          tenantId: tx.ctx.tenantId,
          teamMemberId,
          locationId,
          weekday: range.weekday,
          startTime: formatTimeOfDay(range.start),
          endTime: formatTimeOfDay(range.end),
        })
        .returning({ id: workingHours.id });
      if (row === undefined) {
        throw new Error('working_hours insert returned no row');
      }
      if (range.breaks.length > 0) {
        await tx.db.insert(workingHourBreaks).values(
          range.breaks.map((pause) => ({
            tenantId: tx.ctx.tenantId,
            workingHoursId: row.id,
            startTime: formatTimeOfDay(pause.start),
            endTime: formatTimeOfDay(pause.end),
          })),
        );
      }
    }
  },

  /** One team member's ranges at every location, breaks attached, in weekday and time order. */
  async listForTeamMember(tx: TenantTx, teamMemberId: string): Promise<StoredWorkingRange[]> {
    const ranges = await tx.db
      .select()
      .from(workingHours)
      .where(
        and(
          eq(workingHours.tenantId, tx.ctx.tenantId),
          eq(workingHours.teamMemberId, teamMemberId),
        ),
      )
      .orderBy(asc(workingHours.weekday), asc(workingHours.startTime));
    const breaks =
      ranges.length === 0
        ? []
        : await tx.db
            .select()
            .from(workingHourBreaks)
            .where(
              and(
                eq(workingHourBreaks.tenantId, tx.ctx.tenantId),
                inArray(
                  workingHourBreaks.workingHoursId,
                  ranges.map((range) => range.id),
                ),
              ),
            )
            .orderBy(asc(workingHourBreaks.startTime));
    return ranges.map((range) => ({
      locationId: range.locationId,
      weekday: range.weekday as Weekday,
      start: minutesOf(range.startTime),
      end: minutesOf(range.endTime),
      breaks: breaks
        .filter((pause) => pause.workingHoursId === range.id)
        .map((pause) => ({ start: minutesOf(pause.startTime), end: minutesOf(pause.endTime) })),
    }));
  },
};

export const exceptionsRepository = {
  async insert(tx: TenantTx, input: ResolvedException): Promise<AvailabilityException> {
    const rows = await tx.db
      .insert(availabilityExceptions)
      .values({ tenantId: tx.ctx.tenantId, ...input })
      .returning();
    return one(rows, 'availability_exceptions insert');
  },

  async delete(tx: TenantTx, id: string): Promise<boolean> {
    const rows = await tx.db
      .delete(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.tenantId, tx.ctx.tenantId),
          eq(availabilityExceptions.id, id),
        ),
      )
      .returning({ id: availabilityExceptions.id });
    return rows.length > 0;
  },

  /** Exceptions that have not ended by `now`, earliest first. */
  listCurrent(tx: TenantTx, now: Date): Promise<AvailabilityException[]> {
    return tx.db
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.tenantId, tx.ctx.tenantId),
          gte(availabilityExceptions.endsAt, now),
        ),
      )
      .orderBy(asc(availabilityExceptions.startsAt), asc(availabilityExceptions.id));
  },
};

export const serviceAreasRepository = {
  async replace(tx: TenantTx, teamMemberId: string, districts: readonly string[]): Promise<void> {
    await tx.db
      .delete(teamMemberServiceAreas)
      .where(
        and(
          eq(teamMemberServiceAreas.tenantId, tx.ctx.tenantId),
          eq(teamMemberServiceAreas.teamMemberId, teamMemberId),
        ),
      );
    if (districts.length > 0) {
      await tx.db.insert(teamMemberServiceAreas).values(
        districts.map((postcodeDistrict) => ({
          tenantId: tx.ctx.tenantId,
          teamMemberId,
          postcodeDistrict,
        })),
      );
    }
  },

  async list(tx: TenantTx, teamMemberId: string): Promise<string[]> {
    const rows = await tx.db
      .select({ district: teamMemberServiceAreas.postcodeDistrict })
      .from(teamMemberServiceAreas)
      .where(
        and(
          eq(teamMemberServiceAreas.tenantId, tx.ctx.tenantId),
          eq(teamMemberServiceAreas.teamMemberId, teamMemberId),
        ),
      )
      .orderBy(asc(teamMemberServiceAreas.postcodeDistrict));
    return rows.map((row) => row.district);
  },
};

export const dailyCapacityRepository = {
  async upsert(
    tx: TenantTx,
    teamMemberId: string,
    maxEventsPerDate: number,
  ): Promise<DailyCapacityRule> {
    const rows = await tx.db
      .insert(dailyCapacityRules)
      .values({ tenantId: tx.ctx.tenantId, teamMemberId, maxEventsPerDate })
      .onConflictDoUpdate({
        target: [dailyCapacityRules.tenantId, dailyCapacityRules.teamMemberId],
        set: { maxEventsPerDate, updatedAt: sql`now()` },
      })
      .returning();
    return one(rows, 'daily_capacity_rules upsert');
  },

  async remove(tx: TenantTx, teamMemberId: string): Promise<void> {
    await tx.db
      .delete(dailyCapacityRules)
      .where(
        and(
          eq(dailyCapacityRules.tenantId, tx.ctx.tenantId),
          eq(dailyCapacityRules.teamMemberId, teamMemberId),
        ),
      );
  },

  async find(tx: TenantTx, teamMemberId: string): Promise<DailyCapacityRule | null> {
    const [row] = await tx.db
      .select()
      .from(dailyCapacityRules)
      .where(
        and(
          eq(dailyCapacityRules.tenantId, tx.ctx.tenantId),
          eq(dailyCapacityRules.teamMemberId, teamMemberId),
        ),
      );
    return row ?? null;
  },
};
