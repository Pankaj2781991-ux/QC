import crypto from 'crypto';

import type { Evidence, QcRuleDefinition, QcRuleResult } from '@qc/qc-engine';

import type { QcPublicError } from './qcPublicError.js';

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type RuleStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'ERROR';

export type EvidenceRef = {
  kind: 'TEXT_SNIPPET' | 'FIELD_VALUE' | 'FILE_REF' | 'SHEET_CELL' | 'TIME_RANGE' | 'GENERIC';
  title: string;
  detail?: string;
  source?: {
    storagePath?: string;
    fileName?: string;
    contentType?: string;
  };
  location?: {
    fieldPath?: Array<string | number>;
    line?: number;
    column?: number;
    sheet?: string;
    row?: number;
    cell?: string;
    startMs?: number;
    endMs?: number;
  };
  snippet?: {
    text: string;
    start?: number;
    end?: number;
  };
};

export type RuleResultDoc = {
  order: number;
  ruleId: string;
  ruleName: string;
  ruleType: string;
  weight: number;
  severity: string;
  status: RuleStatus;
  score: number;
  reason?: string;
  evidence: EvidenceRef[];
  error?: QcPublicError;
};

export type InputFingerprint = { type: 'SHA256'; value: string };

export function sha256Base16(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function fingerprintFromNormalizedInput(normalized: unknown): InputFingerprint {
  const text = stableStringify(normalized);
  const hex = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return { type: 'SHA256', value: hex };
}

function ruleOutcomeToStatus(outcome: QcRuleResult['outcome']): RuleStatus {
  if (outcome === 'PASS') return 'PASS';
  if (outcome === 'FAIL') return 'FAIL';
  if (outcome === 'ERROR') return 'ERROR';
  // qc-engine uses SKIP; results system exposes NOT_EVALUATED.
  return 'NOT_EVALUATED';
}

function firstReasonFromEvidence(evidence: Evidence[]): string | undefined {
  const e = evidence?.find((x) => typeof x?.message === 'string' && x.message.length > 0);
  return e?.message;
}

function evidenceToRefs(
  evidence: Evidence[],
  options?: { storagePath?: string; fileName?: string; contentType?: string; contextPrefix?: string }
): EvidenceRef[] {
  const prefix = typeof options?.contextPrefix === 'string' && options.contextPrefix.length > 0 ? options.contextPrefix : '';
  return (evidence ?? []).map((e) => {
    const ref: EvidenceRef = {
      kind: 'GENERIC',
      title: e.type,
      detail: prefix && e.message ? `${prefix}${e.message}` : e.message,
      ...(options?.storagePath || options?.fileName || options?.contentType
        ? {
            source: {
              ...(options?.storagePath ? { storagePath: options.storagePath } : {}),
              ...(options?.fileName ? { fileName: options.fileName } : {}),
              ...(options?.contentType ? { contentType: options.contentType } : {})
            }
          }
        : {}),
      ...(e.path?.length ? { location: { fieldPath: e.path as Array<string | number> } } : {})
    };

    // Optional structured hints from meta (best-effort, customer-safe).
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    if (e.type === 'AUDIO_DURATION_LIMIT' && typeof meta.durationMs === 'number') {
      ref.kind = 'TIME_RANGE';
      ref.title = 'Audio duration';
      ref.detail = `Duration: ${Math.round(meta.durationMs)} ms`;
    }

    return ref;
  });
}

export function mapRuleResultToDoc(input: {
  order: number;
  rule: QcRuleDefinition;
  result: QcRuleResult;
  source?: { storagePath?: string; fileName?: string; contentType?: string };
  contextPrefix?: string;
}): RuleResultDoc {
  const status = ruleOutcomeToStatus(input.result.outcome);
  const base: RuleResultDoc = {
    order: input.order,
    ruleId: input.result.ruleId,
    ruleName: input.rule.name,
    ruleType: input.result.type,
    weight: input.result.weight,
    severity: input.result.severity,
    status,
    score: input.result.score,
    evidence: evidenceToRefs(input.result.evidence ?? [], {
      ...(input.source ?? {}),
      ...(input.contextPrefix ? { contextPrefix: input.contextPrefix } : {})
    })
  };

  const reason = status === 'FAIL' || status === 'NOT_EVALUATED' ? firstReasonFromEvidence(input.result.evidence ?? []) : undefined;
  const withReason = reason ? { ...base, reason } : base;

  if (status === 'ERROR') {
    const err = input.result.error;
    const publicErr: QcPublicError = {
      category: 'RULE_EVALUATION',
      code: err?.code ?? 'RULE_EVALUATION_ERROR',
      message: 'This rule could not be evaluated for the provided input.',
      ...(err?.message ? { help: `Details: ${err.message}` } : {}),
      retryable: false
    };
    return { ...withReason, error: publicErr };
  }

  return withReason;
}

export function summarizeRuleStatuses(ruleDocs: RuleResultDoc[]) {
  const counts = { total: ruleDocs.length, pass: 0, fail: 0, notEvaluated: 0, error: 0 };
  for (const r of ruleDocs) {
    if (r.status === 'PASS') counts.pass++;
    else if (r.status === 'FAIL') counts.fail++;
    else if (r.status === 'ERROR') counts.error++;
    else counts.notEvaluated++;
  }
  return counts;
}
