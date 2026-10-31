import { describe, expect, it } from 'vitest';

import {
  assertCan,
  can,
  MEMBERSHIP_ROLES,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  PermissionDeniedError,
} from './permissions';

describe('permission matrix', () => {
  it('grants owners every permission', () => {
    expect(PERMISSIONS.filter((permission) => !can('owner', permission))).toEqual([]);
  });

  it('denies staff exactly the owner-only permissions', () => {
    expect(PERMISSIONS.filter((permission) => !can('staff', permission))).toEqual(
      OWNER_ONLY_PERMISSIONS,
    );
    expect(can('staff', 'workspace.view')).toBe(true);
  });

  it('lists every owner-only permission as a real permission', () => {
    for (const permission of OWNER_ONLY_PERMISSIONS) {
      expect(PERMISSIONS).toContain(permission);
    }
    expect(MEMBERSHIP_ROLES).toEqual(['owner', 'staff']);
  });

  it('assertCan throws a typed error naming role and permission', () => {
    expect(() => {
      assertCan('staff', 'flags.update');
    }).toThrow(PermissionDeniedError);
    try {
      assertCan('staff', 'members.invite');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'PermissionDeniedError',
        role: 'staff',
        permission: 'members.invite',
      });
    }
    expect(() => {
      assertCan('owner', 'members.invite');
    }).not.toThrow();
  });
});
