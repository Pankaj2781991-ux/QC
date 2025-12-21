import { ApiError } from './errors.js';
import { getAdmin, type DecodedIdToken } from './firebaseAdmin.js';

export type AuthedRequest = {
  uid: string;
  tenantId: string;
  role: 'Admin' | 'Manager' | 'Viewer';
  token: DecodedIdToken;
};

export async function requireAuth(authorizationHeader: string | undefined): Promise<AuthedRequest> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new ApiError('UNAUTHENTICATED', 'Missing Bearer token', 401);
  }

  const idToken = authorizationHeader.slice('Bearer '.length).trim();
  if (!idToken) throw new ApiError('UNAUTHENTICATED', 'Missing Bearer token', 401);

  const { auth } = getAdmin();
  const token = await auth.verifyIdToken(idToken);
  const tenantId = (token as any).tenantId as string | undefined;
  const role = (token as any).role as AuthedRequest['role'] | undefined;

  if (!tenantId || !role) {
    throw new ApiError('FAILED_PRECONDITION', 'User is not provisioned for a tenant', 412);
  }

  return { uid: token.uid, tenantId, role, token };
}

export function requireRole(actual: AuthedRequest['role'], required: AuthedRequest['role']): void {
  const rank = actual === 'Admin' ? 3 : actual === 'Manager' ? 2 : 1;
  const need = required === 'Admin' ? 3 : required === 'Manager' ? 2 : 1;
  if (rank < need) throw new ApiError('FORBIDDEN', `Requires role ${required}`, 403);
}
