import {
  asTextFromInput,
  QC_ENGINE_VERSION,
  QcExecutionError,
  QcRuleValidationError,
  getValueAtPath
} from './types.js';

import type {
  Evidence,
  QcAiSignals,
  QcExecutionContext,
  QcExecutionOptions,
  QcNormalizedInput,
  QcRuleDefinition,
  QcRuleResult,
  QcRunResult
} from './types.js';

function normalizeCase(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLowerCase();
}

function resultBase(rule: QcRuleDefinition): Omit<QcRuleResult, 'outcome' | 'score' | 'evidence' | 'error'> {
  return {
    ruleId: rule.ruleId,
    version: rule.version,
    type: rule.type,
    severity: rule.severity,
    weight: rule.weight
  };
}

function pass(rule: QcRuleDefinition, evidence: Evidence[] = []): QcRuleResult {
  return {
    ...resultBase(rule),
    outcome: 'PASS',
    score: 1,
    evidence
  };
}

function fail(rule: QcRuleDefinition, evidence: Evidence[] = []): QcRuleResult {
  return {
    ...resultBase(rule),
    outcome: 'FAIL',
    score: 0,
    evidence
  };
}

function skip(rule: QcRuleDefinition, reason: string): QcRuleResult {
  return {
    ...resultBase(rule),
    outcome: 'SKIP',
    score: 1,
    evidence: [{ type: 'SKIP_REASON', message: reason }]
  };
}

function errorResult(rule: QcRuleDefinition, message: string, evidence: Evidence[] = []): QcRuleResult {
  return {
    ...resultBase(rule),
    outcome: 'ERROR',
    score: 0,
    evidence,
    error: { code: 'RULE_EVALUATION_ERROR', message }
  };
}

function assertKind<K extends QcNormalizedInput['kind']>(
  input: QcNormalizedInput,
  expectedKind: K,
  rule: QcRuleDefinition
): asserts input is Extract<QcNormalizedInput, { kind: K }> {
  if (input.kind !== expectedKind) {
    throw new QcExecutionError(
      `Rule ${rule.ruleId} (${rule.type}) expects input kind '${expectedKind}', got '${input.kind}'.`
    );
  }
}

function evalTextRegex(rule: Extract<QcRuleDefinition, { type: 'TEXT_REGEX' }>, input: QcNormalizedInput): QcRuleResult {
  const text = asTextFromInput(input, rule.params.fieldPath);
  if (text === undefined) return skip(rule, 'No text available for evaluation');

  const flags = rule.params.flags ?? '';
  const regex = new RegExp(rule.params.pattern, flags);
  const matched = regex.test(text);

  const evidence: Evidence[] = [
    {
      type: 'TEXT_REGEX',
      message: matched ? 'Regex matched' : 'Regex did not match',
      meta: { pattern: rule.params.pattern, flags }
    }
  ];

  const shouldPass = rule.params.mustMatch ? matched : !matched;
  return shouldPass ? pass(rule, evidence) : fail(rule, evidence);
}

function evalTextKeywordBlacklist(
  rule: Extract<QcRuleDefinition, { type: 'TEXT_KEYWORD_BLACKLIST' }>,
  input: QcNormalizedInput
): QcRuleResult {
  const text = asTextFromInput(input, rule.params.fieldPath);
  if (text === undefined) return skip(rule, 'No text available for evaluation');

  const haystack = normalizeCase(text, rule.params.caseSensitive);
  const found: string[] = [];

  for (const keyword of rule.params.keywords) {
    const needle = normalizeCase(keyword, rule.params.caseSensitive);
    if (needle.length > 0 && haystack.includes(needle)) found.push(keyword);
  }

  if (found.length === 0) {
    return pass(rule, [{ type: 'TEXT_KEYWORD_BLACKLIST', message: 'No blacklisted keywords found' }]);
  }

  return fail(rule, [
    {
      type: 'TEXT_KEYWORD_BLACKLIST',
      message: 'Blacklisted keywords detected',
      meta: { found }
    }
  ]);
}

function evalTextRequiredPhrase(
  rule: Extract<QcRuleDefinition, { type: 'TEXT_REQUIRED_PHRASE' }>,
  input: QcNormalizedInput
): QcRuleResult {
  const text = asTextFromInput(input, rule.params.fieldPath);
  if (text === undefined) return skip(rule, 'No text available for evaluation');

  const haystack = normalizeCase(text, rule.params.caseSensitive);
  const needle = normalizeCase(rule.params.phrase, rule.params.caseSensitive);
  const ok = needle.length > 0 && haystack.includes(needle);

  return ok
    ? pass(rule, [{ type: 'TEXT_REQUIRED_PHRASE', message: 'Required phrase present' }])
    : fail(rule, [{ type: 'TEXT_REQUIRED_PHRASE', message: 'Required phrase missing', meta: { phrase: rule.params.phrase } }]);
}

function evalNumericRange(rule: Extract<QcRuleDefinition, { type: 'NUMERIC_RANGE' }>, input: QcNormalizedInput): QcRuleResult {
  assertKind(input, 'record', rule);
  const value = getValueAtPath(input.record, rule.params.fieldPath);
  if (value === undefined || value === null) {
    return fail(rule, [
      {
        type: 'NUMERIC_RANGE',
        message: 'Numeric value missing',
        path: rule.params.fieldPath
      }
    ]);
  }

  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) {
    return fail(rule, [
      {
        type: 'NUMERIC_RANGE',
        message: 'Value is not numeric',
        path: rule.params.fieldPath,
        meta: { value }
      }
    ]);
  }

  const { min, max, inclusiveMin, inclusiveMax } = rule.params;
  const minOk =
    min === undefined ? true : inclusiveMin ? numeric >= min : numeric > min;
  const maxOk =
    max === undefined ? true : inclusiveMax ? numeric <= max : numeric < max;

  const ok = minOk && maxOk;
  return ok
    ? pass(rule, [{ type: 'NUMERIC_RANGE', message: 'Value within range', path: rule.params.fieldPath, meta: { numeric, min, max } }])
    : fail(rule, [{ type: 'NUMERIC_RANGE', message: 'Value out of range', path: rule.params.fieldPath, meta: { numeric, min, max } }]);
}

function evalRequiredField(rule: Extract<QcRuleDefinition, { type: 'REQUIRED_FIELD' }>, input: QcNormalizedInput): QcRuleResult {
  assertKind(input, 'record', rule);
  const value = getValueAtPath(input.record, rule.params.fieldPath);
  const exists = !(value === undefined || value === null);

  if (!exists) {
    return fail(rule, [{ type: 'REQUIRED_FIELD', message: 'Field missing', path: rule.params.fieldPath }]);
  }

  if (typeof value === 'string' && value.length === 0 && !rule.params.allowEmptyString) {
    return fail(rule, [{ type: 'REQUIRED_FIELD', message: 'Field empty string not allowed', path: rule.params.fieldPath }]);
  }

  return pass(rule, [{ type: 'REQUIRED_FIELD', message: 'Field present', path: rule.params.fieldPath }]);
}

function evalExcelRequiredColumns(
  rule: Extract<QcRuleDefinition, { type: 'EXCEL_REQUIRED_COLUMNS' }>,
  input: QcNormalizedInput
): QcRuleResult {
  assertKind(input, 'table', rule);

  const columns = rule.params.caseSensitive
    ? input.columns
    : input.columns.map((c: string) => c.toLowerCase());
  const required = rule.params.caseSensitive
    ? rule.params.requiredColumns
    : rule.params.requiredColumns.map((c: string) => c.toLowerCase());

  const missing: string[] = [];
  for (const [i, req] of required.entries()) {
    if (!columns.includes(req)) missing.push(rule.params.requiredColumns[i] ?? req);
  }

  if (missing.length === 0) {
    return pass(rule, [{ type: 'EXCEL_REQUIRED_COLUMNS', message: 'All required columns present' }]);
  }

  return fail(rule, [{ type: 'EXCEL_REQUIRED_COLUMNS', message: 'Missing required columns', meta: { missing } }]);
}

function evalExcelAllCaps(rule: Extract<QcRuleDefinition, { type: 'EXCEL_ALL_CAPS' }>, input: QcNormalizedInput): QcRuleResult {
  assertKind(input, 'table', rule);

  const colIndex = input.columns.indexOf(rule.params.column);
  if (colIndex === -1) {
    return fail(rule, [{ type: 'EXCEL_ALL_CAPS', message: 'Column not found', meta: { column: rule.params.column } }]);
  }

  let total = 0;
  let caps = 0;

  for (const row of input.rows) {
    let cell: unknown;
    if (Array.isArray(row)) {
      cell = row[colIndex];
    } else if (row && typeof row === 'object') {
      cell = (row as Record<string, unknown>)[rule.params.column];
    }

    if (typeof cell !== 'string') continue;
    const trimmed = cell.trim();
    if (trimmed.length === 0) continue;

    total++;
    if (trimmed === trimmed.toUpperCase()) caps++;
  }

  if (total === 0) return skip(rule, 'No string cells to evaluate');

  const ratio = caps / total;
  const ok = ratio >= rule.params.minCapsRatio;
  const evidence: Evidence[] = [
    {
      type: 'EXCEL_ALL_CAPS',
      message: ok ? 'All-caps ratio meets threshold' : 'All-caps ratio below threshold',
      meta: { column: rule.params.column, ratio, total, caps, minCapsRatio: rule.params.minCapsRatio }
    }
  ];

  return ok ? pass(rule, evidence) : fail(rule, evidence);
}

function evalAudioDurationLimit(
  rule: Extract<QcRuleDefinition, { type: 'AUDIO_DURATION_LIMIT' }>,
  input: QcNormalizedInput
): QcRuleResult {
  assertKind(input, 'audio', rule);

  const ok = input.durationMs <= rule.params.maxDurationMs;
  return ok
    ? pass(rule, [{ type: 'AUDIO_DURATION_LIMIT', message: 'Audio duration within limit', meta: { durationMs: input.durationMs } }])
    : fail(rule, [{ type: 'AUDIO_DURATION_LIMIT', message: 'Audio duration exceeds limit', meta: { durationMs: input.durationMs, maxDurationMs: rule.params.maxDurationMs } }]);
}

function parseDateOrMillis(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function evalSlaTimeDifference(
  rule: Extract<QcRuleDefinition, { type: 'SLA_TIME_DIFFERENCE' }>,
  input: QcNormalizedInput
): QcRuleResult {
  assertKind(input, 'record', rule);

  const startValue = getValueAtPath(input.record, rule.params.startFieldPath);
  const endValue = getValueAtPath(input.record, rule.params.endFieldPath);

  const startMs = parseDateOrMillis(startValue);
  const endMs = parseDateOrMillis(endValue);

  if (startMs === undefined || endMs === undefined) {
    return fail(rule, [
      {
        type: 'SLA_TIME_DIFFERENCE',
        message: 'Start or end timestamp missing/unparseable',
        meta: { startValue, endValue }
      }
    ]);
  }

  const diff = Math.abs(endMs - startMs);
  const ok = diff <= rule.params.maxDifferenceMs;

  return ok
    ? pass(rule, [{ type: 'SLA_TIME_DIFFERENCE', message: 'SLA time difference within limit', meta: { diffMs: diff } }])
    : fail(rule, [{ type: 'SLA_TIME_DIFFERENCE', message: 'SLA time difference exceeds limit', meta: { diffMs: diff, maxDifferenceMs: rule.params.maxDifferenceMs } }]);
}

function evalToneClassification(
  rule: Extract<QcRuleDefinition, { type: 'TONE_CLASSIFICATION' }>,
  aiSignals?: QcAiSignals
): QcRuleResult {
  const signal = aiSignals?.tone;
  if (!signal) return skip(rule, 'No AI tone signal available');

  const meetsConfidence = signal.confidence >= rule.params.threshold;
  const labelIsFail = signal.label ? rule.params.failLabels.includes(signal.label) : false;

  const ok = !(meetsConfidence && labelIsFail);
  const evidence: Evidence[] = [
    {
      type: 'TONE_CLASSIFICATION',
      message: ok ? 'Tone did not trigger failure thresholds' : 'Tone triggered failure thresholds',
      meta: { label: signal.label, confidence: signal.confidence, threshold: rule.params.threshold, failLabels: rule.params.failLabels }
    },
    ...(signal.evidence ?? [])
  ];

  return ok ? pass(rule, evidence) : fail(rule, evidence);
}

function evalImpliedAbuseDetection(
  rule: Extract<QcRuleDefinition, { type: 'IMPLIED_ABUSE_DETECTION' }>,
  aiSignals?: QcAiSignals
): QcRuleResult {
  const signal = aiSignals?.impliedAbuse;
  if (!signal) return skip(rule, 'No AI implied-abuse signal available');

  const ok = signal.confidence < rule.params.threshold;
  const evidence: Evidence[] = [
    {
      type: 'IMPLIED_ABUSE_DETECTION',
      message: ok ? 'Implied abuse confidence below threshold' : 'Implied abuse confidence above threshold',
      meta: { confidence: signal.confidence, threshold: rule.params.threshold }
    },
    ...(signal.evidence ?? [])
  ];

  return ok ? pass(rule, evidence) : fail(rule, evidence);
}

function evaluateRule(ctx: QcExecutionContext, rule: QcRuleDefinition): QcRuleResult {
  if (!rule.enabled) return skip(rule, 'Rule disabled');

  try {
    switch (rule.type) {
      case 'TEXT_REGEX':
        return evalTextRegex(rule, ctx.input);
      case 'TEXT_KEYWORD_BLACKLIST':
        return evalTextKeywordBlacklist(rule, ctx.input);
      case 'TEXT_REQUIRED_PHRASE':
        return evalTextRequiredPhrase(rule, ctx.input);
      case 'NUMERIC_RANGE':
        return evalNumericRange(rule, ctx.input);
      case 'REQUIRED_FIELD':
        return evalRequiredField(rule, ctx.input);
      case 'EXCEL_REQUIRED_COLUMNS':
        return evalExcelRequiredColumns(rule, ctx.input);
      case 'EXCEL_ALL_CAPS':
        return evalExcelAllCaps(rule, ctx.input);
      case 'AUDIO_DURATION_LIMIT':
        return evalAudioDurationLimit(rule, ctx.input);
      case 'SLA_TIME_DIFFERENCE':
        return evalSlaTimeDifference(rule, ctx.input);
      case 'TONE_CLASSIFICATION':
        return evalToneClassification(rule, ctx.aiSignals);
      case 'IMPLIED_ABUSE_DETECTION':
        return evalImpliedAbuseDetection(rule, ctx.aiSignals);
      default:
        return errorResult(rule, `Unsupported rule type: ${(rule as QcRuleDefinition).type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errorResult(rule, message);
  }
}

export type RunQcRequest = {
  input: QcNormalizedInput;
  rules: QcRuleDefinition[];
  executedAtIso: string; // caller-provided for audit determinism
  aiSignals?: QcAiSignals;
  options?: QcExecutionOptions;
};

export function runQc(request: RunQcRequest): QcRunResult {
  const passScoreThreshold = request.options?.passScoreThreshold ?? 1;
  const blockerFailureForcesFail = request.options?.blockerFailureForcesFail ?? true;

  if (passScoreThreshold < 0 || passScoreThreshold > 1) {
    throw new QcRuleValidationError('passScoreThreshold must be between 0 and 1');
  }

  const ctx: QcExecutionContext = {
    input: request.input,
    executedAtIso: request.executedAtIso,
    ...(request.aiSignals ? { aiSignals: request.aiSignals } : {})
  };

  const results = request.rules.map((r) => evaluateRule(ctx, r));

  const enabledResults = results.filter((r) => r.outcome !== 'SKIP');
  const totalWeight = enabledResults.reduce((sum, r) => sum + r.weight, 0);

  const weightedScore =
    totalWeight <= 0
      ? 1
      : enabledResults.reduce((sum, r) => sum + r.score * r.weight, 0) / totalWeight;

  const failedRuleIds = results.filter((r) => r.outcome === 'FAIL').map((r) => r.ruleId);

  const hasBlockerFail = blockerFailureForcesFail
    ? results.some((r) => r.outcome === 'FAIL' && r.severity === 'BLOCKER')
    : false;

  const overallOutcome = hasBlockerFail || weightedScore < passScoreThreshold ? 'FAIL' : 'PASS';

  return {
    summary: {
      engineVersion: QC_ENGINE_VERSION,
      executedAt: request.executedAtIso,
      overallOutcome,
      overallScore: Math.max(0, Math.min(1, weightedScore)),
      failedRuleIds
    },
    ruleResults: results
  };
}
