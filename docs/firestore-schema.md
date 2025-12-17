# Firestore Schema (Tenant-Scoped)

This platform enforces tenant isolation primarily through document paths.
All tenant data lives under:

- `tenants/{tenantId}/...`

This allows security rules to permit `list` operations safely without relying on query constraints.

## Collections

### tenants

- `tenants/{tenantId}`
  - `name: string`
  - `status: 'active' | 'suspended'`
  - `createdAt: Timestamp`
  - `createdByUid: string`

### users

- `tenants/{tenantId}/users/{uid}`
  - `uid: string`
  - `tenantId: string`
  - `email: string`
  - `role: 'Admin' | 'Manager' | 'Viewer'`
  - `status: 'active' | 'invited' | 'disabled'`
  - `createdAt: Timestamp`

> Source of truth for authorization is Firebase Auth custom claims (`tenantId`, `role`).

### qc_templates

- `tenants/{tenantId}/qc_templates/{templateId}`
  - `templateId: string`
  - `tenantId: string`
  - `name: string`
  - `description?: string`
  - `currentVersion: number`
  - `createdAt: Timestamp`
  - `createdByUid: string`
  - `updatedAt: Timestamp`

### qc_template_versions

- `tenants/{tenantId}/qc_template_versions/{templateVersionId}`
  - `templateId: string`
  - `version: number`
  - `tenantId: string`
  - `ruleIds: string[]` (or embedded `rules[]` snapshot)
  - `ruleSnapshot: object[]` (JSON rules; immutable snapshot used for execution)
  - `engineVersion: string`
  - `createdAt: Timestamp`
  - `createdByUid: string`

### qc_rules

- `tenants/{tenantId}/qc_rules/{ruleId}`
  - `ruleId: string`
  - `tenantId: string`
  - `type: string`
  - `version: number`
  - `definition: object` (validated against qc-engine schema)
  - `createdAt: Timestamp`

### qc_runs

- `tenants/{tenantId}/qc_runs/{runId}`
  - `runId: string`
  - `tenantId: string`
  - `status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'`
  - `mode: 'SYNC' | 'ASYNC'`
  - `templateId: string`
  - `templateName: string` (snapshot for audit)
  - `templateVersion: number`
  - `templateVersionId: string`
  - `inputSource: 'INLINE' | 'UPLOAD' | 'INTEGRATION'`
  - `inputRef: { inline?: unknown, upload?: { storagePath: string, fileName?: string, contentType?: string }, integration?: { integrationId: string, query?: object } }`
  - `inputFingerprint: { type: 'SHA256', value: string }` (for reproducibility)
  - `engineVersion: string`
  - `requestedAt: Timestamp`
  - `requestedByUid: string`
  - `startedAt?: Timestamp`
  - `completedAt?: Timestamp`
  - `resultId?: string`
  - `error?: { category, code, message, help?, retryable }` (customer-safe)

### qc_run_results (immutable)

- `tenants/{tenantId}/qc_run_results/{resultId}`
  - `resultId: string`
  - `tenantId: string`
  - `runId: string`
  - `engineVersion: string`
  - `executedAt: Timestamp`
  - `summary: { overallOutcome, overallScore, failedRuleIds, ruleCounts }`
  - `integrity: { templateVersionId, templateVersion, inputFingerprint }`
  - `createdAt: Timestamp`

#### qc_run_results rule_results (paged)

- `tenants/{tenantId}/qc_run_results/{resultId}/rule_results/{ruleResultId}`
  - `order: number`
  - `ruleId: string`
  - `ruleName: string` (snapshot)
  - `ruleType: string`
  - `status: 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'ERROR'`
  - `weight: number`
  - `severity: string`
  - `reason?: string`
  - `evidence: array` (structured evidence references)
  - `error?: { category, code, message, help?, retryable }`

### integrations

- `tenants/{tenantId}/integrations/{integrationId}`
  - `tenantId: string`
  - `type: string`
  - `authType: 'API_KEY' | 'OAUTH'`
  - `config: object`
  - `credentialsRef: { encryptedBlobPath: string, keyId: string }` (server-only)
  - `createdAt: Timestamp`

### audit_logs (immutable)

- `tenants/{tenantId}/audit_logs/{auditId}`
  - `tenantId: string`
  - `actorUid: string`
  - `action: string`
  - `resourceType: string`
  - `resourceId: string`
  - `at: Timestamp`
  - `requestId?: string`
  - `meta?: object`

## Notes

- All client writes are routed through Cloud Functions to guarantee audit logging and prevent privilege escalation.
- Storage paths are tenant-scoped: `tenants/{tenantId}/uploads/{runId}/{fileName}`.
