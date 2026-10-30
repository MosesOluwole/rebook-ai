import { z } from 'zod';

import { ValidationError } from './errors';
import { isIanaTimeZone, TIME_ZONE_MESSAGE } from './time-zone';

/** Lowercase letters, digits and hyphens, 1 to 63 characters, no leading or trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const newTenantSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(SLUG_PATTERN, 'lowercase letters, digits and hyphens, 1 to 63 characters'),
  timeZone: z.string().refine(isIanaTimeZone, TIME_ZONE_MESSAGE),
});

export type NewTenant = z.infer<typeof newTenantSchema>;

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timeZone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function parseNewTenant(input: unknown): NewTenant {
  const result = newTenantSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'tenant',
      result.error.issues.map((issue) => `${issue.path.join('.') || 'tenant'}: ${issue.message}`),
    );
  }
  return result.data;
}
