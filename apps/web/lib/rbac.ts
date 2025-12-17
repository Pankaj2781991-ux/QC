export type UserRole = 'Admin' | 'Manager' | 'Viewer';

export function roleRank(role: UserRole | undefined): number {
  if (role === 'Admin') return 3;
  if (role === 'Manager') return 2;
  if (role === 'Viewer') return 1;
  return 0;
}

export function roleAtLeast(role: UserRole | undefined, required: UserRole): boolean {
  return roleRank(role) >= roleRank(required);
}
