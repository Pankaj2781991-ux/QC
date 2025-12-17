# QC Error Taxonomy (Customer-Safe)

This document defines the **public** error categories and codes exposed to tenants for QC runs and rule evaluations.

## Goals

- Customer-safe: no secrets, no internal stack traces, no connector details.
- Stable: category + code are durable identifiers.
- Actionable: message + optional help instruct the user what to do next.
- Machine-friendly: includes a `retryable` boolean.

## Public error shape

All public errors use the following structure:

```ts
{
  category: 'VALIDATION' | 'INTEGRATION' | 'EXECUTION' | 'RULE_EVALUATION';
  code: string;
  message: string;
  help?: string;
  retryable: boolean;
}
```

## Categories

### VALIDATION

Used when the run cannot start or cannot be evaluated due to invalid inputs or references.

Typical sources:
- Upload references missing/invalid
- Storage path mismatch (tenant isolation / deterministic run addressing)
- Missing required fields (template/version/integration id)

Examples:
- `UPLOAD_MISSING_STORAGE_PATH` (retryable: false)
- `UPLOAD_INVALID_STORAGE_PATH` (retryable: false)

### INTEGRATION

Used when the input source is an integration and the connector cannot fetch/normalize data.

Typical sources:
- Credential missing/invalid
- Connector rate limits or upstream failures
- Integration not found

Guidance:
- Prefer `retryable: true` for transient upstream failures.
- Prefer `retryable: false` for configuration errors.

### EXECUTION

Used when the run fails for unexpected reasons not covered by other categories.

Typical sources:
- Unhandled exceptions
- Internal transient issues

Default fallback:
- `EXECUTION_FAILED` (retryable: true)

### RULE_EVALUATION

Used when a specific rule cannot be evaluated (the overall run may still complete, but that rule is `ERROR`).

Typical sources:
- Type mismatch (e.g., rule expects numeric field)
- Missing data required for evaluation

Default mapping:
- `RULE_EVALUATION_ERROR` (retryable: false)

## Where errors appear

### Run-level (`qc_runs/{runId}`)

- If a run fails before completing, `qc_runs.error` is set (category typically `VALIDATION`, `INTEGRATION`, or `EXECUTION`).
- `qc_runs.status` becomes `FAILED`.

### Rule-level (`qc_run_results/{resultId}/rule_results/{ruleResultId}`)

- If an individual rule errors, that rule’s `status` is `ERROR` and `error` is populated (category `RULE_EVALUATION`).
- The run can still end in `SUCCEEDED`.

## Mapping guidance

- Use **specific** codes for validation and integration failures.
- Keep `message` short and user-facing.
- Put deeper troubleshooting steps into `help`.
- Do not include:
  - secrets (API keys, tokens)
  - internal URLs
  - stack traces
  - raw upstream response bodies

## Current implementation references

- Public error type and helpers: apps/functions/src/lib/qcPublicError.ts
- Processor mappings and defaults: apps/functions/src/lib/qcProcessor.ts
- Rule-level error mapping: apps/functions/src/lib/qcResultMapping.ts
