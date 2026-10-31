import { z } from 'zod';

import { type BusinessType, businessTypeSchema } from './business-type';
import { ValidationError } from './errors';
import { canonicalTimeZone, TIME_ZONE_MESSAGE } from './time-zone';

/** Lowercase letters, digits and hyphens, 1 to 63 characters, no leading or trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A time zone as the user typed it, stored in its canonical form (docs/adr/ADR-003-time-zones.md).
 * The transform rejects what the rule rejects, so a value that passes here always satisfies the
 * database CHECK `rebook.is_time_zone()`.
 */
export const timeZoneSchema = z.string().transform((value, ctx) => {
  const zone = canonicalTimeZone(value);
  if (zone === null) {
    ctx.addIssue({ code: 'custom', message: TIME_ZONE_MESSAGE });
    return z.NEVER;
  }
  return zone;
});

export const tenantNameSchema = z.string().trim().min(1).max(120);

export const newTenantSchema = z.strictObject({
  name: tenantNameSchema,
  slug: z.string().regex(SLUG_PATTERN, 'lowercase letters, digits and hyphens, 1 to 63 characters'),
  businessType: businessTypeSchema,
  timeZone: timeZoneSchema,
});

export type NewTenant = z.infer<typeof newTenantSchema>;

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly businessType: BusinessType;
  readonly timeZone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an owner may change later. The slug is immutable (links depend on it). */
export const tenantSettingsSchema = z.strictObject({
  name: tenantNameSchema,
  businessType: businessTypeSchema,
  timeZone: timeZoneSchema,
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

function issuesOf(error: z.ZodError, fallback: string): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || fallback}: ${issue.message}`);
}

export function parseNewTenant(input: unknown): NewTenant {
  const result = newTenantSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('tenant', issuesOf(result.error, 'tenant'));
  }
  return result.data;
}

export function parseTenantSettings(input: unknown): TenantSettings {
  const result = tenantSettingsSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('tenant settings', issuesOf(result.error, 'settings'));
  }
  return result.data;
}
