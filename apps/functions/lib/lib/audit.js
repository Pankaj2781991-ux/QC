import { v4 as uuidv4 } from 'uuid';
import { tenantSubdocPath } from './firestorePaths.js';
import { getAdmin, Timestamp } from './firebaseAdmin.js';
export async function writeAuditLog(input) {
    const id = uuidv4();
    const entry = {
        tenantId: input.tenantId,
        actorUid: input.actorUid,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        at: new Date().toISOString(),
        ...(input.actorRole ? { actorRole: input.actorRole } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.meta ? { meta: input.meta } : {})
    };
    const { db } = getAdmin();
    await db
        .doc(tenantSubdocPath(input.tenantId, 'audit_logs', id))
        .create({ ...entry, at: Timestamp.fromDate(new Date(entry.at)) });
    return id;
}
