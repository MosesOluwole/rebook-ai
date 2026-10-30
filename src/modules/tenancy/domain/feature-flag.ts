import { z } from 'zod';

import { ValidationError } from './errors';

/** Lowercase identifier, 2 to 64 characters; mirrors the CHECK on tenant_feature_flags.flag. */
export const featureFlagNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be a lowercase identifier such as shared_unlisted_link');

export type FeatureFlagName = z.infer<typeof featureFlagNameSchema>;

export function parseFeatureFlagName(input: unknown): FeatureFlagName {
  const result = featureFlagNameSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'feature flag',
      result.error.issues.map((issue) => `flag: ${issue.message}`),
    );
  }
  return result.data;
}
