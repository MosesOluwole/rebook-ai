import { z } from 'zod';

import { ACTOR_KINDS } from './actor';
import { ValidationError } from './errors';

/**
 * Everything a database transaction must know before it touches tenant data. `withTenant`
 * validates this and installs it as transaction-local settings that every RLS policy reads.
 */
export const requestIdSchema = z.string().trim().min(1).max(128);

export const tenantContextSchema = z
  .strictObject({
    tenantId: z.uuid(),
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.uuid().nullable(),
    requestId: requestIdSchema,
  })
  .superRefine((ctx, issues) => {
    if ((ctx.actorKind === 'user' || ctx.actorKind === 'customer') && ctx.actorId === null) {
      issues.addIssue({
        code: 'custom',
        path: ['actorId'],
        message: `actorId is required when actorKind is '${ctx.actorKind}'`,
      });
    }
    if (ctx.actorKind === 'anonymous' && ctx.actorId !== null) {
      issues.addIssue({
        code: 'custom',
        path: ['actorId'],
        message: 'actorId must be null for an anonymous actor',
      });
    }
  });

export type TenantContext = z.infer<typeof tenantContextSchema>;

export class TenantContextError extends ValidationError {
  constructor(issues: readonly string[]) {
    super('tenant context', issues);
    this.name = 'TenantContextError';
  }
}

export function parseTenantContext(input: unknown): TenantContext {
  const result = tenantContextSchema.safeParse(input);
  if (!result.success) {
    throw new TenantContextError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'context'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function parseRequestId(input: unknown): string {
  const result = requestIdSchema.safeParse(input);
  if (!result.success) {
    throw new TenantContextError(result.error.issues.map((issue) => `requestId: ${issue.message}`));
  }
  return result.data;
}
