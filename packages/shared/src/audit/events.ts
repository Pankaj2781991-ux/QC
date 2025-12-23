export type AuditAction =
  | 'TENANT_BOOTSTRAP'
  | 'TEMPLATE_CREATE'
  | 'TEMPLATE_UPDATE'
  | 'TEMPLATE_DELETE'
  | 'TEMPLATE_VERSION_CREATE'
  | 'QC_RUN_CREATE'
  | 'QC_RUN_PROCESS'
  | 'INTEGRATION_CREATE'
  | 'INTEGRATION_UPDATE'
  | 'USER_ROLE_UPDATE';

export type AuditLogEntry = {
  tenantId: string;
  actorUid: string;
  actorRole?: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  at: string; // ISO
  requestId?: string;
  meta?: Record<string, unknown>;
};
