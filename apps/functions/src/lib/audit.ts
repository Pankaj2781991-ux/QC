import { v4 as uuidv4 } from 'uuid';
import type { AuditAction, AuditLogEntry } from '@qc/shared';
import { tenantSubdocPath } from './firestorePaths.js';
import { getAdmin, Timestamp } from './firebaseAdmin.js';

export async function writeAuditLog(input: {
  tenantId: string;
  actorUid: string;
  actorRole?: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}) {
  const id = uuidv4();
  const entry: AuditLogEntry = {
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
