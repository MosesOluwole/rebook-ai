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

/**
 * Flags the back office knows how to show. Anything matching the name pattern can be stored; this
 * list is what the settings page offers. `ai_chat` gates the AI assistant (docs/architecture.md §9),
 * default off.
 */
export const KNOWN_FEATURE_FLAGS = ['ai_chat'] as const;
