import { z } from 'zod';

import { ValidationError } from './errors';
import { isIanaTimeZone, TIME_ZONE_MESSAGE } from './time-zone';

export const newLocationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  timeZone: z.string().refine(isIanaTimeZone, TIME_ZONE_MESSAGE),
});

export type NewLocation = z.infer<typeof newLocationSchema>;

export function parseNewLocation(input: unknown): NewLocation {
  const result = newLocationSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'location',
      result.error.issues.map((issue) => `${issue.path.join('.') || 'location'}: ${issue.message}`),
    );
  }
  return result.data;
}
