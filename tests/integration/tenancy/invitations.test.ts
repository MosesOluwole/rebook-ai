import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AlreadyMemberError,
  auditLogsRepository,
  CannotRevokeSelfError,
  DuplicateInvitationError,
  EmailNotVerifiedError,
  INVITATION_TTL_MS,
  listMembers,
  listOpenInvitations,
  NotFoundError,
  revokeInvitation,
  revokeMember,
  updateBusinessSettings,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  createAuthUser,
  type FixtureUser,
  hashToken,
  removeAuthUsers,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Invitations and membership management (docs/phases.md Phase 2): hashed tokens, acceptance
 * only by a signed-in user with the matching verified email, identical 404s for every bad link,
 * idempotent acceptance, and the owner-only member and settings commands.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;
let invitee: FixtureUser;
let impostor: FixtureUser;
const extraUsers: string[] = [];

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'inv');
  invitee = await createAuthUser(owner, 'invitee');
  impostor = await createAuthUser(owner, 'impostor');
});

afterAll(async () => {
  await pair.cleanup();
  await removeAuthUsers(owner, [invitee.id, impostor.id, ...extraUsers]);
  await app.close();
  await owner.close();
});

const ownerCtx = () => app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function invite(email: string, role: 'owner' | 'staff' = 'staff') {
  const ctx = await ownerCtx();
  return app.tenancy.withTenant(ctx, (tx) => app.tenancy.createInvitation(tx, { email, role }));
}

describe('creating invitations', () => {
  it('stores only the hash of a 256-bit token, expires in a week, and audits without the address', async () => {
    const before = Date.now();
    const address = `probe-${randomUUID().slice(0, 8)}@example.invalid`;
    const { invitation, token } = await invite(address.toUpperCase());

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.email).toBe(address);
    expect(invitation.role).toBe('staff');
    expect(invitation.invitedBy).toBe(pair.a.userId);
    expect(invitation.tokenHash).toBe(hashToken(token));
    expect(invitation.tokenHash).not.toContain(token);
    const ttl = invitation.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(INVITATION_TTL_MS - 60_000);
    expect(ttl).toBeLessThan(INVITATION_TTL_MS + 60_000);

    const ctx = await ownerCtx();
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    expect(open.map((row) => row.id)).toContain(invitation.id);
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    const entry = audit.find(
      (row) => row.action === 'invitation.created' && row.entityId === invitation.id,
    );
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.after)).not.toContain('@');
  });

  it('rejects a malformed address or role before writing anything', async () => {
    const ctx = await ownerCtx();
    await expect(
      app.tenancy.withTenant(ctx, (tx) =>
        app.tenancy.createInvitation(tx, { email: 'not-an-address', role: 'staff' }),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(
      app.tenancy.withTenant(ctx, (tx) =>
        app.tenancy.createInvitation(tx, { email: invitee.email, role: 'admin' }),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('accepting invitations', () => {
  it('is accepted by the signed-in user with the matching verified email, once, idempotently', async () => {
    const { invitation, token } = await invite(invitee.email);
    const actor = actorFor(invitee, { requestId: 'accept-1' });

    const membership = await app.tenancy.acceptInvitation(pair.a.slug, token, actor);
    expect(membership).toMatchObject({ tenantId: pair.a.id, userId: invitee.id, role: 'staff' });

    const again = await app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(invitee));
    expect(again.id).toBe(membership.id);

    const [count] = await owner.sql<{ n: number }[]>`
      select count(*)::int as n from rebook.tenant_memberships
      where tenant_id = ${pair.a.id} and user_id = ${invitee.id}
    `;
    expect(count?.n).toBe(1);

    expect(await app.tenancy.listMyTenants(actor)).toEqual([
      {
        tenantId: pair.a.id,
        slug: pair.a.slug,
        name: pair.a.name,
        businessType: 'other_timed',
        role: 'staff',
      },
    ]);

    const ctx = await ownerCtx();
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    expect(
      audit
        .filter((row) => row.requestId === 'accept-1')
        .map((row) => row.action)
        .sort(),
    ).toEqual(['invitation.accepted', 'membership.created']);
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    expect(open.map((row) => row.id)).not.toContain(invitation.id);
  });

  it('returns the same NotFoundError for a wrong user, wrong token, wrong slug, expired, revoked or used invite', async () => {
    const { invitation, token } = await invite(invitee.email);
    const failures: Record<string, unknown> = {};

    failures.wrongUser = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(impostor)),
    );
    // Flip the first character so the probe differs from the real token in every run. Replacing
    // the last character with a fixed letter is wrong one run in sixteen (a 32-byte base64url
    // token ends in one of 16 characters), which made this test flaky.
    const wrongToken = `${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}`;
    expect(wrongToken).not.toBe(token);
    failures.wrongToken = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, wrongToken, actorFor(invitee)),
    );
    failures.malformedToken = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, 'short', actorFor(invitee)),
    );
    failures.wrongSlug = await failureOf(
      app.tenancy.acceptInvitation(`${pair.a.slug}-nope`, token, actorFor(invitee)),
    );
    failures.otherTenantSlug = await failureOf(
      app.tenancy.acceptInvitation(pair.b.slug, token, actorFor(invitee)),
    );

    await owner.sql`update rebook.tenant_invitations set expires_at = now() - interval '1 minute' where id = ${invitation.id}`;
    failures.expired = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(invitee)),
    );
    await owner.sql`update rebook.tenant_invitations set expires_at = now() + interval '1 day' where id = ${invitation.id}`;

    const ctx = await ownerCtx();
    await app.tenancy.withTenant(ctx, (tx) => revokeInvitation(tx, invitation.id));
    failures.revoked = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(invitee)),
    );
    failures.revokedTwice = await failureOf(
      app.tenancy.withTenant(ctx, (tx) => revokeInvitation(tx, invitation.id)),
    );

    const used = await invite(invitee.email);
    await owner.sql`update rebook.tenant_invitations set accepted_at = now(), accepted_by = ${impostor.id} where id = ${used.invitation.id}`;
    failures.usedByOther = await failureOf(
      app.tenancy.acceptInvitation(pair.a.slug, used.token, actorFor(invitee)),
    );

    const shapes = Object.values(failures).map((error) => ({
      isNotFound: error instanceof NotFoundError,
      name: (error as Error).name,
      message: (error as Error).message,
      ownProperties: Object.getOwnPropertyNames(error).sort(),
    }));
    expect(Object.keys(failures)).toHaveLength(9);
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
    expect(shapes[0]?.isNotFound).toBe(true);
  });

  it('tells only the addressee to verify their email, and never a stranger', async () => {
    const { token } = await invite(invitee.email);
    await expect(
      app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(invitee, { emailVerified: false })),
    ).rejects.toBeInstanceOf(EmailNotVerifiedError);
    await expect(
      app.tenancy.acceptInvitation(
        pair.a.slug,
        token,
        actorFor(impostor, { emailVerified: false }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reactivates a revoked member who is invited again, keeping one membership row', async () => {
    const returning = await createAuthUser(owner, 'returning');
    extraUsers.push(returning.id);
    const first = await invite(returning.email, 'staff');
    const membership = await app.tenancy.acceptInvitation(
      pair.a.slug,
      first.token,
      actorFor(returning),
    );

    const ctx = await ownerCtx();
    const revoked = await app.tenancy.withTenant(ctx, (tx) => revokeMember(tx, membership.id));
    expect(revoked.revokedAt).not.toBeNull();
    await expect(
      app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(returning)),
    ).rejects.toBeInstanceOf(NotFoundError);

    const second = await invite(returning.email, 'owner');
    const back = await app.tenancy.acceptInvitation(
      pair.a.slug,
      second.token,
      actorFor(returning, { requestId: 'reactivate-1' }),
    );
    expect(back.id).toBe(membership.id);
    expect(back).toMatchObject({ role: 'owner', revokedAt: null });
    const resolved = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(returning));
    expect(resolved.role).toBe('owner');

    // Audited as a reactivation (not a creation) with the effective role.
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    const mine = audit.filter((row) => row.requestId === 'reactivate-1');
    expect(mine.map((row) => row.action).sort()).toEqual([
      'invitation.accepted',
      'membership.reactivated',
    ]);
    expect(mine.find((row) => row.action === 'membership.reactivated')).toMatchObject({
      before: { role: 'staff', active: false },
      after: { role: 'owner', active: true, via: 'invitation' },
    });
  });
});

describe('one open invitation per address', () => {
  it('refuses a second open invitation for the same address, in any case, until it is revoked', async () => {
    const address = `once-${randomUUID().slice(0, 8)}@example.invalid`;
    const first = await invite(address);
    await expect(invite(address.toUpperCase())).rejects.toBeInstanceOf(DuplicateInvitationError);
    await expect(invite(` ${address} `)).rejects.toBeInstanceOf(DuplicateInvitationError);

    const ctx = await ownerCtx();
    await app.tenancy.withTenant(ctx, (tx) => revokeInvitation(tx, first.invitation.id));
    const again = await invite(address);
    expect(again.invitation.id).not.toBe(first.invitation.id);

    const [index] = await owner.sql<{ def: string }[]>`
      select pg_get_indexdef(indexrelid) as def from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'tenant_invitations_open_email_unique'
    `;
    expect(index?.def).toMatch(/UNIQUE INDEX .* \(tenant_id, lower\(email\)\) WHERE/);
  });

  it('replaces an expired open invitation instead of blocking the address, and audits it', async () => {
    const address = `expired-${randomUUID().slice(0, 8)}@example.invalid`;
    const first = await invite(address);
    await owner.sql`update rebook.tenant_invitations set expires_at = now() - interval '1 minute' where id = ${first.invitation.id}`;

    const second = await invite(address);
    expect(second.invitation.id).not.toBe(first.invitation.id);

    const ctx = await ownerCtx();
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    expect(open.map((row) => row.id)).toContain(second.invitation.id);
    expect(open.map((row) => row.id)).not.toContain(first.invitation.id);
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    expect(
      audit.find(
        (row) => row.action === 'invitation.revoked' && row.entityId === first.invitation.id,
      )?.after,
    ).toEqual({ reason: 'expired, replaced' });
    // The old link is dead for good.
    await expect(
      app.tenancy.acceptInvitation(pair.a.slug, first.token, actorFor(invitee)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets exactly one of two simultaneous invitations for one address through', async () => {
    const address = `race-${randomUUID().slice(0, 8)}@example.invalid`;
    const results = await Promise.allSettled([invite(address), invite(address)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DuplicateInvitationError);
  });

  it('tells an active member they are already a member and changes nothing', async () => {
    const member = await createAuthUser(owner, 'member');
    extraUsers.push(member.id);
    const first = await invite(member.email, 'staff');
    const membership = await app.tenancy.acceptInvitation(
      pair.a.slug,
      first.token,
      actorFor(member),
    );
    expect(membership.role).toBe('staff');

    // A later invitation (first one is closed, so it can be created) must not change the role.
    const second = await invite(member.email, 'owner');
    await expect(
      app.tenancy.acceptInvitation(pair.a.slug, second.token, actorFor(member)),
    ).rejects.toBeInstanceOf(AlreadyMemberError);

    const ctx = await ownerCtx();
    const still = await app.tenancy.withTenant(ctx, (tx) => listMembers(tx));
    expect(still.find((row) => row.userId === member.id)?.role).toBe('staff');
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    expect(open.map((row) => row.id)).toContain(second.invitation.id);
  });
});

describe('members and settings (owner-only commands)', () => {
  it('revokes a member, audits it, and refuses to revoke the caller', async () => {
    const ctx = await ownerCtx();
    const leaver = await createAuthUser(owner, 'leaver');
    extraUsers.push(leaver.id);
    const { token } = await invite(leaver.email);
    const membership = await app.tenancy.acceptInvitation(pair.a.slug, token, actorFor(leaver));

    const members = await app.tenancy.withTenant(ctx, (tx) => listMembers(tx));
    expect(members.map((row) => row.id)).toContain(membership.id);

    const revoked = await app.tenancy.withTenant(ctx, (tx) => revokeMember(tx, membership.id));
    expect(revoked.id).toBe(membership.id);
    const after = await app.tenancy.withTenant(ctx, (tx) => listMembers(tx));
    expect(after.map((row) => row.id)).not.toContain(membership.id);
    await expect(
      app.tenancy.withTenant(ctx, (tx) => revokeMember(tx, membership.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      app.tenancy.withTenant(ctx, (tx) => revokeMember(tx, pair.a.membershipId)),
    ).rejects.toBeInstanceOf(CannotRevokeSelfError);

    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    expect(
      audit.find((row) => row.action === 'membership.revoked' && row.entityId === membership.id),
    ).toMatchObject({ before: { active: true }, after: { active: false } });
  });

  it('updates business settings with canonical time zone, audits before and after, keeps the slug', async () => {
    const ctx = await ownerCtx();
    const updated = await app.tenancy.withTenant(ctx, (tx) =>
      updateBusinessSettings(tx, {
        name: 'Renamed Practice',
        businessType: 'midwife',
        timeZone: 'gb',
      }),
    );
    expect(updated).toMatchObject({
      id: pair.a.id,
      slug: pair.a.slug,
      name: 'Renamed Practice',
      businessType: 'midwife',
      timeZone: 'Europe/London',
    });
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    const entry = audit.find((row) => row.action === 'tenant.updated');
    expect(entry?.before).toEqual({
      name: pair.a.name,
      businessType: 'other_timed',
      timeZone: 'Europe/London',
    });
    expect(entry?.after).toEqual({
      name: 'Renamed Practice',
      businessType: 'midwife',
      timeZone: 'Europe/London',
    });
    await expect(
      app.tenancy.withTenant(ctx, (tx) =>
        updateBusinessSettings(tx, {
          name: 'X',
          businessType: 'midwife',
          timeZone: 'UTC',
          slug: 'new',
        }),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

// ---- Follow-up verification (test engineer) -------------------------------------------------

describe('one open invitation per address: scope, race width and role protection', () => {
  it('is scoped to the tenant: the same address may be invited to A and to B at the same time', async () => {
    const address = `both-${randomUUID().slice(0, 8)}@example.invalid`;
    const inA = await invite(address);
    const ctxB = await app.tenancy.resolveTenantForUser(pair.b.slug, actorFor(pair.b));
    const inB = await app.tenancy.withTenant(ctxB, (tx) =>
      app.tenancy.createInvitation(tx, { email: address, role: 'staff' }),
    );
    expect(inA.invitation.tenantId).toBe(pair.a.id);
    expect(inB.invitation.tenantId).toBe(pair.b.id);
    // And a second one in B is refused just like in A.
    await expect(
      app.tenancy.withTenant(ctxB, (tx) =>
        app.tenancy.createInvitation(tx, { email: address.toUpperCase(), role: 'owner' }),
      ),
    ).rejects.toBeInstanceOf(DuplicateInvitationError);
  });

  it('lets exactly one of ten simultaneous invitations through on a wide pool', async () => {
    const wide = await connectAppDb({ max: 10 });
    try {
      const address = `wide-${randomUUID().slice(0, 8)}@example.invalid`;
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, async () => {
          const ctx = await wide.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
          return wide.tenancy.withTenant(ctx, (tx) =>
            wide.tenancy.createInvitation(tx, { email: address, role: 'staff' }),
          );
        }),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(DuplicateInvitationError);
      }
      const ctx = await ownerCtx();
      const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
      expect(open.filter((row) => row.email === address)).toHaveLength(1);
    } finally {
      await wide.close();
    }
  });

  it('an owner accepting a staff invitation for their own address stays owner and is told they are a member', async () => {
    const { invitation, token } = await invite(pair.a.email, 'staff');
    const before = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    expect(before.role).toBe('owner');

    await expect(
      app.tenancy.acceptInvitation(
        pair.a.slug,
        token,
        actorFor(pair.a, { requestId: 'owner-self-accept' }),
      ),
    ).rejects.toBeInstanceOf(AlreadyMemberError);

    const after = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    expect(after.role).toBe('owner');
    const ctx = await ownerCtx();
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    const still = open.find((row) => row.id === invitation.id);
    expect(still).toBeDefined();
    expect(still?.acceptedAt).toBeNull();
    const audit = await app.tenancy.withTenant(ctx, (tx) => auditLogsRepository.listRecent(tx));
    expect(audit.filter((row) => row.requestId === 'owner-self-accept')).toEqual([]);
    expect(new AlreadyMemberError().message).toBe('You are already a member of this business');
  });

  it('the duplicate-invitation message names no address', () => {
    const error = new DuplicateInvitationError();
    expect(error.message).toBe(
      'An invitation for this email address is already open; revoke it to send a new one',
    );
    expect(error.message).not.toContain('@');
  });
});

describe('re-inviting over an expired open invitation (re-verification)', () => {
  it('six owners at once: exactly one new invitation, the expired one closed and audited once', async () => {
    const wide = await connectAppDb({ max: 10 });
    try {
      const address = `expired-race-${randomUUID().slice(0, 8)}@example.invalid`;
      const first = await invite(address);
      await owner.sql`update rebook.tenant_invitations set expires_at = now() - interval '1 minute' where id = ${first.invitation.id}`;

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, async (_, index) => {
          const ctx = await wide.tenancy.resolveTenantForUser(
            pair.a.slug,
            actorFor(pair.a, { requestId: `expired-race-${index}` }),
          );
          return wide.tenancy.withTenant(ctx, (tx) =>
            wide.tenancy.createInvitation(tx, { email: address, role: 'staff' }),
          );
        }),
      );
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof invite>>> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(DuplicateInvitationError);
      }

      const ctx = await ownerCtx();
      const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
      const forAddress = open.filter((row) => row.email === address);
      expect(forAddress.map((row) => row.id)).toEqual([fulfilled[0]?.value.invitation.id]);
      const audit = await app.tenancy.withTenant(ctx, (tx) =>
        auditLogsRepository.listRecent(tx, 500),
      );
      const closed = audit.filter(
        (row) => row.action === 'invitation.revoked' && row.entityId === first.invitation.id,
      );
      expect(closed).toHaveLength(1);
      expect(closed[0]?.after).toEqual({ reason: 'expired, replaced' });
      await expect(
        app.tenancy.acceptInvitation(pair.a.slug, first.token, actorFor(invitee)),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await wide.close();
    }
  });

  it('an unexpired open invitation is still a duplicate even one second before it expires', async () => {
    const address = `fresh-${randomUUID().slice(0, 8)}@example.invalid`;
    const first = await invite(address);
    await owner.sql`update rebook.tenant_invitations set expires_at = now() + interval '1 second' where id = ${first.invitation.id}`;
    await expect(invite(address)).rejects.toBeInstanceOf(DuplicateInvitationError);
    const ctx = await ownerCtx();
    const open = await app.tenancy.withTenant(ctx, (tx) => listOpenInvitations(tx));
    expect(open.filter((row) => row.email === address).map((row) => row.id)).toEqual([
      first.invitation.id,
    ]);
  });
});
