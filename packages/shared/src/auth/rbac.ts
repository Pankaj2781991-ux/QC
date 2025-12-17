export type UserRole = 'Admin' | 'Manager' | 'Viewer';

export const ROLE_ORDER: Record<UserRole, number> = {
  Admin: 3,
  Manager: 2,
  Viewer: 1
};

export function roleAtLeast(actual: UserRole, required: UserRole): boolean {
  return ROLE_ORDER[actual] >= ROLE_ORDER[required];
}

export type AuthClaims = {
  tenantId: string;
  role: UserRole;
};
