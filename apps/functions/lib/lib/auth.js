import * as admin from 'firebase-admin';
import { ApiError } from './errors.js';
export async function requireAuth(authorizationHeader) {
    if (!authorizationHeader?.startsWith('Bearer ')) {
        throw new ApiError('UNAUTHENTICATED', 'Missing Bearer token', 401);
    }
    const idToken = authorizationHeader.slice('Bearer '.length).trim();
    if (!idToken)
        throw new ApiError('UNAUTHENTICATED', 'Missing Bearer token', 401);
    const token = await admin.auth().verifyIdToken(idToken);
    const tenantId = token.tenantId;
    const role = token.role;
    if (!tenantId || !role) {
        throw new ApiError('FAILED_PRECONDITION', 'User is not provisioned for a tenant', 412);
    }
    return { uid: token.uid, tenantId, role, token };
}
export function requireRole(actual, required) {
    const rank = actual === 'Admin' ? 3 : actual === 'Manager' ? 2 : 1;
    const need = required === 'Admin' ? 3 : required === 'Manager' ? 2 : 1;
    if (rank < need)
        throw new ApiError('FORBIDDEN', `Requires role ${required}`, 403);
}
