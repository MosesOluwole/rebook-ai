import { describe, expect, it } from 'vitest';

import { parseTenantContext, TenantContextError } from './tenant-context';

const tenantId = '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f';
const actorId = '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e70';

describe('parseTenantContext', () => {
  it('accepts a user acting in a tenant', () => {
    const ctx = parseTenantContext({ tenantId, actorKind: 'user', actorId, requestId: 'req-1' });
    expect(ctx).toEqual({ tenantId, actorKind: 'user', actorId, requestId: 'req-1' });
  });

  it('accepts an anonymous actor with no id and a system actor either way', () => {
    expect(
      parseTenantContext({ tenantId, actorKind: 'anonymous', actorId: null, requestId: 'r' })
        .actorId,
    ).toBeNull();
    expect(
      parseTenantContext({ tenantId, actorKind: 'system', actorId: null, requestId: 'r' })
        .actorKind,
    ).toBe('system');
    expect(
      parseTenantContext({ tenantId, actorKind: 'system', actorId, requestId: 'r' }).actorId,
    ).toBe(actorId);
  });

  it.each([
    {
      name: 'a non-UUID tenant id',
      ctx: { tenantId: 'acme', actorKind: 'user', actorId, requestId: 'r' },
    },
    {
      name: 'a tenant id taken from a number',
      ctx: { tenantId: 42, actorKind: 'user', actorId, requestId: 'r' },
    },
    {
      name: 'an unknown actor kind',
      ctx: { tenantId, actorKind: 'admin', actorId, requestId: 'r' },
    },
    {
      name: 'a user without an actor id',
      ctx: { tenantId, actorKind: 'user', actorId: null, requestId: 'r' },
    },
    {
      name: 'a customer without an actor id',
      ctx: { tenantId, actorKind: 'customer', actorId: null, requestId: 'r' },
    },
    {
      name: 'an anonymous actor with an id',
      ctx: { tenantId, actorKind: 'anonymous', actorId, requestId: 'r' },
    },
    { name: 'a blank request id', ctx: { tenantId, actorKind: 'user', actorId, requestId: '   ' } },
    {
      name: 'an unexpected property',
      ctx: { tenantId, actorKind: 'user', actorId, requestId: 'r', role: 'owner' },
    },
    { name: 'a missing field', ctx: { tenantId, actorKind: 'user', actorId } },
    { name: 'a non-object', ctx: 'tenant-a' },
  ])('rejects $name', ({ ctx }) => {
    expect(() => parseTenantContext(ctx)).toThrow(TenantContextError);
  });

  it('names the offending field in the error', () => {
    expect(() =>
      parseTenantContext({ tenantId, actorKind: 'user', actorId: null, requestId: 'r' }),
    ).toThrow(/actorId: actorId is required when actorKind is 'user'/);
  });
});
