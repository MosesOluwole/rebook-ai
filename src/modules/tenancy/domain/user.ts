import { z } from 'zod';

import { ValidationError } from './errors';

/**
 * A signed-in staff user as established by the auth gateway from a verified session, never from
 * the cookie payload alone (docs/adr/ADR-004-auth-sessions.md). The email is lower-cased so it
 * can be compared with invitation addresses.
 */
export const authenticatedUserSchema = z.strictObject({
  id: z.uuid(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  emailVerified: z.boolean(),
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

/** Who is acting in a request that has not yet chosen a tenant. */
export const userActorSchema = z.strictObject({
  user: authenticatedUserSchema,
  requestId: z.string().trim().min(1).max(128),
});

export type UserActor = z.infer<typeof userActorSchema>;

export function parseUserActor(input: unknown): UserActor {
  const result = userActorSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'user actor',
      result.error.issues.map((issue) => `${issue.path.join('.') || 'actor'}: ${issue.message}`),
    );
  }
  return result.data;
}
