/**
 * Authorisation inside a tenant (docs/architecture.md §4): RLS answers "which tenant", this
 * matrix answers "which action". Every application command names its permission and checks
 * `can(role, permission)` before touching data; the UI never holds authoritative permission logic.
 */
export const MEMBERSHIP_ROLES = ['owner', 'staff'] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const PERMISSIONS = [
  'members.invite',
  'members.revoke',
  'flags.update',
  'settings.update',
  'services.manage',
  'team.manage',
  'schedules.manage',
  'custom_fields.manage',
  'custom_fields.health_override',
  'workspace.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions only an owner holds (docs/phases.md Phase 2, extended in Phase 3: the business's
 * configuration). `custom_fields.health_override` is separate from `custom_fields.manage` so the
 * override that enables free-text fields for a health business is its own audited decision.
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [
  'members.invite',
  'members.revoke',
  'flags.update',
  'settings.update',
  'services.manage',
  'team.manage',
  'schedules.manage',
  'custom_fields.manage',
  'custom_fields.health_override',
];

const MATRIX: Readonly<Record<MembershipRole, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  staff: new Set<Permission>(['workspace.view']),
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/**
 * A command was called by a role that does not hold its permission. Typed, never swallowed.
 * `role` is 'none' when the caller is not a member at all (a registration or invitation grant,
 * or a non-user actor).
 */
export class PermissionDeniedError extends Error {
  static readonly kind = 'PermissionDeniedError' as const;
  readonly kind = PermissionDeniedError.kind;

  readonly role: MembershipRole | 'none';
  readonly permission: Permission;

  constructor(role: MembershipRole | 'none', permission: Permission) {
    super(`Role '${role}' does not hold permission '${permission}'`);
    this.name = 'PermissionDeniedError';
    this.role = role;
    this.permission = permission;
  }
}

export function assertCan(role: MembershipRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}
