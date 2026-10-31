import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createService, createTeamMember, replaceWorkingHours } from '@/modules/booking';
import { businessTypeGuard, createCustomFieldDefinition } from '@/modules/crm';
import {
  auditLogsRepository,
  listMembers,
  listOpenInvitations,
  OWNER_ONLY_PERMISSIONS,
  type Permission,
  PermissionDeniedError,
  revokeInvitation,
  revokeMember,
  type TenantTx,
  toggleFeatureFlag,
  updateBusinessSettings,
} from '@/modules/tenancy';
import { type DbClient } from '@/shared/db/client';

import { connectAppDb, connectOwnerDb, type AppDb } from '../../helpers/db';
import {
  actorFor,
  contextFor,
  seedTenantPair,
  type TenantPair,
} from '../../helpers/tenant-fixtures';

/**
 * Phase 2 acceptance criterion: a staff user calling any owner-only command gets a typed
 * permission error, tested for every owner-only command. The table below must name a command for
 * every permission in OWNER_ONLY_PERMISSIONS; adding a permission without a command here fails.
 */

let owner: DbClient;
let app: AppDb;
let pair: TenantPair;

beforeAll(async () => {
  owner = await connectOwnerDb();
  app = await connectAppDb();
  pair = await seedTenantPair(owner, 'perm');
  // Owner-only arrangement: the spare user becomes staff in tenant A.
  await owner.sql`
    insert into rebook.tenant_memberships (tenant_id, user_id, role)
    values (${pair.a.id}, ${pair.a.spareUserId}, 'staff')
  `;
});

afterAll(async () => {
  await pair.cleanup();
  await app.close();
  await owner.close();
});

const ownerOnlyCommands: Record<
  Exclude<Permission, 'workspace.view'>,
  (tx: TenantTx) => Promise<unknown>
> = {
  'members.invite': (tx) =>
    app.tenancy.createInvitation(tx, { email: 'new-member@example.invalid', role: 'staff' }),
  'members.revoke': (tx) => revokeMember(tx, pair.a.membershipId),
  'flags.update': (tx) => toggleFeatureFlag(tx, 'permission_probe', true),
  'settings.update': (tx) =>
    updateBusinessSettings(
      tx,
      { name: 'Renamed', businessType: 'midwife', timeZone: 'UTC' },
      businessTypeGuard,
    ),
  // Phase 3. The ids need not exist: the permission check comes before any read.
  'services.manage': (tx) =>
    createService(tx, {
      name: 'Probe',
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      price: '10',
      currency: 'GBP',
    }),
  'team.manage': (tx) => createTeamMember(tx, { displayName: 'Probe' }),
  'schedules.manage': (tx) =>
    replaceWorkingHours(tx, randomUUID(), pair.a.locationId, {
      days: { '1': { ranges: [{ start: '09:00', end: '17:00' }] } },
    }),
  'custom_fields.manage': (tx) =>
    createCustomFieldDefinition(tx, {
      entity: 'service',
      key: 'probe',
      label: 'Probe',
      fieldType: 'number',
    }),
  'custom_fields.health_override': (tx) =>
    createCustomFieldDefinition(tx, {
      entity: 'client',
      key: 'probe_note',
      label: 'Probe note',
      fieldType: 'text',
      healthFreeTextOverride: true,
    }),
};

/** Owner-only read and revoke paths that share a permission with a command above. */
const ownerOnlyExtras: Record<string, (tx: TenantTx) => Promise<unknown>> = {
  'listOpenInvitations (members.invite)': (tx) => listOpenInvitations(tx),
  'revokeInvitation (members.revoke)': (tx) => revokeInvitation(tx, pair.a.invitationId),
};

describe('owner-only commands', () => {
  it('has a command under test for every owner-only permission', () => {
    expect(Object.keys(ownerOnlyCommands).sort()).toEqual([...OWNER_ONLY_PERMISSIONS].sort());
  });

  it.each(Object.entries(ownerOnlyCommands))(
    'deny staff %s with a typed PermissionDeniedError and change nothing',
    async (permission, command) => {
      const staff = actorFor({ userId: pair.a.spareUserId, email: pair.a.spareEmail });
      const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, staff);
      expect(ctx.role).toBe('staff');

      const auditBefore = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        auditLogsRepository.listRecent(tx, 500),
      );

      await expect(app.tenancy.withTenant(ctx, command)).rejects.toMatchObject({
        name: 'PermissionDeniedError',
        role: 'staff',
        permission,
      });
      await expect(app.tenancy.withTenant(ctx, command)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );

      const auditAfter = await app.tenancy.withTenant(contextFor(pair.a.id), (tx) =>
        auditLogsRepository.listRecent(tx, 500),
      );
      expect(auditAfter).toHaveLength(auditBefore.length);
    },
  );

  it.each(Object.entries(ownerOnlyExtras))('deny staff %s too', async (_label, command) => {
    const staff = actorFor({ userId: pair.a.spareUserId, email: pair.a.spareEmail });
    const ctx = await app.tenancy.resolveTenantForUser(pair.a.slug, staff);
    await expect(app.tenancy.withTenant(ctx, command)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it.each(Object.entries(ownerOnlyCommands))(
    'deny a non-user actor %s (no role at all)',
    async (permission, command) => {
      await expect(app.tenancy.withTenant(contextFor(pair.a.id), command)).rejects.toMatchObject({
        name: 'PermissionDeniedError',
        role: 'none',
        permission,
      });
    },
  );

  it('lets staff see the member list (workspace.view) and lets the owner run owner commands', async () => {
    const staff = actorFor({ userId: pair.a.spareUserId, email: pair.a.spareEmail });
    const staffCtx = await app.tenancy.resolveTenantForUser(pair.a.slug, staff);
    const members = await app.tenancy.withTenant(staffCtx, (tx) => listMembers(tx));
    expect(members.map((member) => member.userId).sort()).toEqual(
      [pair.a.userId, pair.a.spareUserId].sort(),
    );

    const ownerCtx = await app.tenancy.resolveTenantForUser(pair.a.slug, actorFor(pair.a));
    const change = await app.tenancy.withTenant(ownerCtx, (tx) =>
      toggleFeatureFlag(tx, 'permission_probe', true),
    );
    expect(change).toEqual({ flag: 'permission_probe', before: null, after: true });
  });
});
