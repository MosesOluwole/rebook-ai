import { z } from 'zod';

import { validationErrorFrom } from '@/shared/kernel/validation-error';

import { MAX_BUFFER_MINUTES } from './service';
import { wholeNumber } from './numbers';

/**
 * Team members are the people who deliver services (the design's "staff"), each optionally linked
 * to a membership so they can sign in. Service areas and travel time are for home visits
 * (docs/architecture.md §1, private midwives); daily capacity is for request-mode services and is
 * enforced from Phase 7.
 */

export const teamMemberInputSchema = z.strictObject({
  displayName: z.string().trim().min(1, 'required').max(80, 'at most 80 characters'),
  /** A membership of this tenant, or blank for someone who does not sign in. */
  membershipId: z
    .union([z.literal(''), z.null(), z.uuid('choose a member from the list')])
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type TeamMemberInput = z.output<typeof teamMemberInputSchema>;

export function parseTeamMemberInput(input: unknown): TeamMemberInput {
  const result = teamMemberInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('team member', result.error, 'teamMember');
  }
  return result.data;
}

/**
 * A UK postcode district (the outward code): "SW1A", "M1", "B33", "EH12". The inward part of a
 * full postcode is refused so that a list of areas never becomes a list of addresses.
 */
const POSTCODE_DISTRICT = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

export const MAX_SERVICE_AREAS = 200;

export function normalisePostcodeDistrict(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export const serviceAreasInputSchema = z.strictObject({
  /** Districts separated by commas, spaces or new lines. */
  districts: z
    .string()
    .max(4000, 'too long')
    .transform((value, ctx) => {
      const districts = [
        ...new Set(
          value
            .split(/[\s,;]+/)
            .map(normalisePostcodeDistrict)
            .filter((district) => district !== ''),
        ),
      ];
      const invalid = districts.filter((district) => !POSTCODE_DISTRICT.test(district));
      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${String(invalid.length)} entr${invalid.length === 1 ? 'y is' : 'ies are'} not a postcode district such as SW1A or M1 (no full postcodes)`,
        });
        return z.NEVER;
      }
      if (districts.length > MAX_SERVICE_AREAS) {
        ctx.addIssue({ code: 'custom', message: `at most ${String(MAX_SERVICE_AREAS)} districts` });
        return z.NEVER;
      }
      return districts.sort();
    }),
  travelBeforeMinutes: wholeNumber(0, MAX_BUFFER_MINUTES, 'minutes'),
  travelAfterMinutes: wholeNumber(0, MAX_BUFFER_MINUTES, 'minutes'),
});

export type ServiceAreasInput = z.output<typeof serviceAreasInputSchema>;

export function parseServiceAreasInput(input: unknown): ServiceAreasInput {
  const result = serviceAreasInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('service areas', result.error, 'serviceAreas');
  }
  return result.data;
}

export const MAX_EVENTS_PER_DATE = 50;

export const dailyCapacityInputSchema = z.strictObject({
  maxEventsPerDate: wholeNumber(1, MAX_EVENTS_PER_DATE, 'events'),
});

export function parseDailyCapacityInput(input: unknown): { readonly maxEventsPerDate: number } {
  const result = dailyCapacityInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('daily capacity', result.error, 'dailyCapacity');
  }
  return result.data;
}

export const staffServicesInputSchema = z.strictObject({
  serviceIds: z.array(z.uuid('not a service id')).max(200),
});

export function parseStaffServicesInput(input: unknown): readonly string[] {
  const result = staffServicesInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('services for a team member', result.error, 'serviceIds');
  }
  return [...new Set(result.data.serviceIds)];
}
