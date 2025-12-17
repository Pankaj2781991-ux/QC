# QC Results Model (Enterprise)

This document defines the production-grade, auditable QC run/result schema and execution semantics.

## Enums

### RunStatus

- `QUEUED`: Run accepted and awaiting processing.
- `RUNNING`: Processing has started.
- `SUCCEEDED`: Processing completed and results are persisted.
- `FAILED`: Processing completed but failed (with a customer-safe error).
- `CANCELLED`: Run cancelled before completion (no results written).

### RuleStatus

- `PASS`: Rule evaluated and passed.
- `FAIL`: Rule evaluated and failed.
- `NOT_EVALUATED`: Rule was not evaluated (disabled, missing required input, or not applicable).
- `ERROR`: Rule evaluation errored (rule-level failure, not whole-run failure).

## Firestore Structure (tenant-scoped)

All data lives under `tenants/{tenantId}`.

### Runs

- `tenants/{tenantId}/qc_runs/{runId}`
  - **Identity**
    - `runId: string`
    - `tenantId: string`
  - **Lifecycle**
    - `status: RunStatus`
    - `mode: 'SYNC' | 'ASYNC'`
    - `requestedAt: Timestamp`
    - `requestedByUid: string`
    - `startedAt?: Timestamp`
    - `completedAt?: Timestamp`
  - **Template snapshot (for audit)**
    - `templateId: string`
    - `templateName: string` (snapshot)
    - `templateVersionId: string`
    - `templateVersion: number`
    - `engineVersion: string`
  - **Input source (for audit)**
    - `inputSource: 'INLINE' | 'UPLOAD' | 'INTEGRATION'`
    - `inputRef:`
      - `inline?: { kind: 'text'|'record'|'table'|'audio', ... }` (optional; stored only if inline)
      - `upload?: { storagePath: string, fileName?: string, contentType?: string }`
      - `integration?: { integrationId: string, type: string, authType: 'API_KEY'|'OAUTH', query?: object }`
    - `inputFingerprint:`
      - `type: 'SHA256'`
      - `value: string` (hash of normalized input OR file bytes, depending on source)
  - **Result linkage**
    - `resultId?: string` (points to immutable result doc)
  - **Failure (customer-safe)**
    - `error?: QcPublicError`

### Results (immutable)

- `tenants/{tenantId}/qc_run_results/{resultId}`
  - `resultId: string`
  - `tenantId: string`
  - `runId: string`
  - `createdAt: Timestamp`
  - `engineVersion: string`
  - `executedAt: Timestamp` (engine execution time)
  - `summary:`
    - `overallOutcome: 'PASS' | 'FAIL'`
    - `overallScore: number` ($0..1$)
    - `failedRuleIds: string[]`
    - `ruleCounts: { total: number, pass: number, fail: number, notEvaluated: number, error: number }`
  - `integrity:`
    - `templateVersionId: string`
    - `templateVersion: number`
    - `inputFingerprint: { type: 'SHA256', value: string }`

### Rule results (paged, immutable)

Stored as a subcollection to avoid Firestore 1MB document limits.

- `tenants/{tenantId}/qc_run_results/{resultId}/rule_results/{ruleResultId}`
  - `ruleResultId: string` (server-generated)
  - `order: number` (stable ordering)
  - `ruleId: string`
  - `ruleName: string` (snapshot)
  - `ruleType: string`
  - `weight: number`
  - `severity: 'BLOCKER'|'MAJOR'|'MINOR'|'INFO'`
  - `status: RuleStatus`
  - `score: number` ($0..1$)
  - `reason?: string` (customer-safe, short)
  - `evidence: EvidenceRef[]`
  - `error?: QcPublicError` (only when `status === 'ERROR'`)

## Evidence model

### EvidenceRef

Evidence is structured and customer-safe. It may include optional location details when available.

- `EvidenceRef`
  - `kind: 'TEXT_SNIPPET' | 'FIELD_VALUE' | 'FILE_REF' | 'SHEET_CELL' | 'TIME_RANGE' | 'GENERIC'`
  - `title: string` (short)
  - `detail?: string` (optional)
  - `source?:`
    - `storagePath?: string`
    - `fileName?: string`
    - `contentType?: string`
  - `location?:`
    - `fieldPath?: (string|number)[]`
    - `line?: number`
    - `column?: number`
    - `sheet?: string`
    - `row?: number`
    - `cell?: string`
    - `startMs?: number`
    - `endMs?: number`
  - `snippet?:`
    - `text: string`
    - `start?: number`
    - `end?: number`

## Error model

### QcPublicError

- `category: 'VALIDATION' | 'INTEGRATION' | 'EXECUTION' | 'RULE_EVALUATION'`
- `code: string` (stable, documented)
- `message: string` (human-readable, safe)
- `help?: string` (next-step guidance)
- `retryable: boolean`

## Execution semantics (high level)

- A run transitions: `QUEUED -> RUNNING -> (SUCCEEDED|FAILED)`.
- `CANCELLED` is terminal and stops processing.
- Results are immutable: once a `qc_run_results/{resultId}` exists for a run, it is never overwritten.
- A run is only marked `SUCCEEDED` after all rule results are written.
- Audit logs record creation, lifecycle transitions, and completion/failure.
