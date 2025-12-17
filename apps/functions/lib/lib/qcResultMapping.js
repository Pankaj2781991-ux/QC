import crypto from 'crypto';
export function sha256Base16(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
export function stableStringify(value) {
    const seen = new WeakSet();
    const walk = (v) => {
        if (v === null || v === undefined)
            return v;
        if (typeof v !== 'object')
            return v;
        if (Array.isArray(v))
            return v.map(walk);
        const obj = v;
        if (seen.has(obj))
            return '[Circular]';
        seen.add(obj);
        const out = {};
        for (const k of Object.keys(obj).sort())
            out[k] = walk(obj[k]);
        return out;
    };
    return JSON.stringify(walk(value));
}
export function fingerprintFromNormalizedInput(normalized) {
    const text = stableStringify(normalized);
    const hex = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    return { type: 'SHA256', value: hex };
}
function ruleOutcomeToStatus(outcome) {
    if (outcome === 'PASS')
        return 'PASS';
    if (outcome === 'FAIL')
        return 'FAIL';
    if (outcome === 'ERROR')
        return 'ERROR';
    // qc-engine uses SKIP; results system exposes NOT_EVALUATED.
    return 'NOT_EVALUATED';
}
function firstReasonFromEvidence(evidence) {
    const e = evidence?.find((x) => typeof x?.message === 'string' && x.message.length > 0);
    return e?.message;
}
function evidenceToRefs(evidence, options) {
    return (evidence ?? []).map((e) => {
        const ref = {
            kind: 'GENERIC',
            title: e.type,
            detail: e.message,
            ...(options?.storagePath || options?.fileName || options?.contentType
                ? {
                    source: {
                        ...(options?.storagePath ? { storagePath: options.storagePath } : {}),
                        ...(options?.fileName ? { fileName: options.fileName } : {}),
                        ...(options?.contentType ? { contentType: options.contentType } : {})
                    }
                }
                : {}),
            ...(e.path?.length ? { location: { fieldPath: e.path } } : {})
        };
        // Optional structured hints from meta (best-effort, customer-safe).
        const meta = (e.meta ?? {});
        if (e.type === 'AUDIO_DURATION_LIMIT' && typeof meta.durationMs === 'number') {
            ref.kind = 'TIME_RANGE';
            ref.title = 'Audio duration';
            ref.detail = `Duration: ${Math.round(meta.durationMs)} ms`;
        }
        return ref;
    });
}
export function mapRuleResultToDoc(input) {
    const status = ruleOutcomeToStatus(input.result.outcome);
    const base = {
        order: input.order,
        ruleId: input.result.ruleId,
        ruleName: input.rule.name,
        ruleType: input.result.type,
        weight: input.result.weight,
        severity: input.result.severity,
        status,
        score: input.result.score,
        evidence: evidenceToRefs(input.result.evidence ?? [], input.source)
    };
    const reason = status === 'FAIL' || status === 'NOT_EVALUATED' ? firstReasonFromEvidence(input.result.evidence ?? []) : undefined;
    const withReason = reason ? { ...base, reason } : base;
    if (status === 'ERROR') {
        const err = input.result.error;
        const publicErr = {
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
export function summarizeRuleStatuses(ruleDocs) {
    const counts = { total: ruleDocs.length, pass: 0, fail: 0, notEvaluated: 0, error: 0 };
    for (const r of ruleDocs) {
        if (r.status === 'PASS')
            counts.pass++;
        else if (r.status === 'FAIL')
            counts.fail++;
        else if (r.status === 'ERROR')
            counts.error++;
        else
            counts.notEvaluated++;
    }
    return counts;
}
