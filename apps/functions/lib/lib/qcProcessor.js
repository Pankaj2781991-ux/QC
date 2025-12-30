import { v4 as uuidv4 } from 'uuid';
import { QcRuleDefinitionSchema, runQc } from '@qc/qc-engine';
import { tenantSubdocPath } from './firestorePaths.js';
import { normalizeFromBuffer, normalizeInlineJson } from './qcNormalize.js';
import { writeAuditLog } from './audit.js';
import { accessSecretString } from './secretManager.js';
import { getConnectorForIntegration } from '../connectors/registry.js';
import { asPublicError } from './qcPublicError.js';
import { getAdmin, Timestamp } from './firebaseAdmin.js';
import { fingerprintFromNormalizedInput, mapRuleResultToDoc, sha256Base16, summarizeRuleStatuses } from './qcResultMapping.js';
async function fetchTemplateVersion(tenantId, templateVersionId) {
    const { db } = getAdmin();
    const snap = await db.doc(tenantSubdocPath(tenantId, 'qc_template_versions', templateVersionId)).get();
    if (!snap.exists)
        throw new Error('Template version not found');
    return snap.data();
}
async function fetchTemplateRules(tenantId, templateId) {
    const { db } = getAdmin();
    const snap = await db.doc(tenantSubdocPath(tenantId, 'qc_templates', templateId)).get();
    if (!snap.exists)
        throw new Error('Template not found');
    const data = snap.data();
    return data?.rules ?? [];
}
async function loadInputForRun(tenantId, run) {
    if (run.inputSource === 'INLINE') {
        return normalizeInlineJson(run.inputRef.inline);
    }
    if (run.inputSource === 'UPLOAD') {
        if (!run.inputRef.upload?.storagePath)
            throw new Error('Missing storagePath');
        const { storage } = getAdmin();
        const bucket = storage.bucket();
        const file = bucket.file(run.inputRef.upload.storagePath);
        const [buffer] = await file.download();
        // Attempt to use stored metadata if present.
        let contentType = run.inputRef.upload.contentType;
        if (!contentType) {
            const [meta] = await file.getMetadata();
            contentType = meta.contentType;
        }
        return normalizeFromBuffer({
            buffer: buffer,
            ...(run.inputRef.upload.fileName ? { fileName: run.inputRef.upload.fileName } : {}),
            ...(contentType ? { contentType } : {})
        });
    }
    if (run.inputSource === 'INTEGRATION') {
        if (!run.inputRef.integration?.integrationId)
            throw new Error('Missing integrationId');
        const { db } = getAdmin();
        const snap = await db.doc(tenantSubdocPath(tenantId, 'integrations', run.inputRef.integration.integrationId)).get();
        if (!snap.exists)
            throw new Error('Integration not found');
        const integration = snap.data();
        const connectorConfig = {
            tenantId,
            integrationId: snap.id,
            type: integration.type,
            authType: integration.authType,
            config: integration.config ?? {}
        };
        const connector = getConnectorForIntegration(connectorConfig);
        const credentials = {};
        if (connectorConfig.authType === 'API_KEY') {
            const secretName = integration.credentialsRef?.secretResourceName;
            if (!secretName)
                throw new Error('Missing credentialsRef.secretResourceName');
            credentials.apiKey = await accessSecretString(secretName);
        }
        else {
            throw new Error('OAuth credentials not implemented yet');
        }
        const normalized = await connector.fetchStructuredData({
            config: connectorConfig,
            credentials,
            ...(run.inputRef.integration.query ? { query: run.inputRef.integration.query } : {})
        });
        if (normalized.kind === 'text')
            return { kind: 'text', text: normalized.text };
        if (normalized.kind === 'record')
            return { kind: 'record', record: normalized.record };
        if (normalized.kind === 'table')
            return { kind: 'table', columns: normalized.columns, rows: normalized.rows };
        return { kind: 'record', record: { value: normalized } };
    }
    throw new Error(`Unsupported inputSource: ${run.inputSource}`);
}
export async function processQcRun(input) {
    const { db, storage } = getAdmin();
    const runRef = db.doc(tenantSubdocPath(input.tenantId, 'qc_runs', input.runId));
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(runRef);
        if (!snap.exists)
            throw new Error('Run not found');
        const run = snap.data();
        if (run.status === 'CANCELLED')
            return;
        if (run.status !== 'QUEUED')
            return;
        tx.update(runRef, { status: 'RUNNING', startedAt: Timestamp.now() });
    });
    const runSnap = await runRef.get();
    const run = runSnap.data();
    if (run.status !== 'RUNNING')
        return;
    try {
        // Fetch rules - from version if provided, otherwise from template directly
        let ruleSnapshot;
        if (run.templateVersionId) {
            const templateVersion = await fetchTemplateVersion(input.tenantId, run.templateVersionId);
            ruleSnapshot = templateVersion.ruleSnapshot;
        }
        else {
            ruleSnapshot = await fetchTemplateRules(input.tenantId, run.templateId);
        }
        const rules = ruleSnapshot.map((r) => QcRuleDefinitionSchema.parse(r));
        // Fail fast on invalid upload references.
        const uploadSource = run.inputSource === 'UPLOAD' ? run.inputRef.upload : undefined;
        if (run.inputSource === 'UPLOAD') {
            if (!uploadSource?.storagePath) {
                throw asPublicError({
                    category: 'VALIDATION',
                    code: 'UPLOAD_MISSING_STORAGE_PATH',
                    message: 'The uploaded file reference is missing.',
                    help: 'Please re-upload the file and try again.',
                    retryable: false
                });
            }
            const expectedPrefix = `tenants/${input.tenantId}/uploads/${run.runId}/`;
            if (!uploadSource.storagePath.startsWith(expectedPrefix)) {
                throw asPublicError({
                    category: 'VALIDATION',
                    code: 'UPLOAD_INVALID_STORAGE_PATH',
                    message: 'The uploaded file reference is invalid.',
                    help: 'Please re-upload the file and try again.',
                    retryable: false
                });
            }
        }
        let normalizedInput;
        let effectiveFingerprint;
        if (run.inputSource === 'UPLOAD') {
            const storagePath = uploadSource.storagePath;
            const bucket = storage.bucket();
            const file = bucket.file(storagePath);
            const [buffer] = await file.download();
            const bytesHash = sha256Base16(buffer);
            // Use run-provided metadata if available; otherwise fetch from object metadata.
            let contentType = uploadSource.contentType;
            if (!contentType) {
                const [meta] = await file.getMetadata();
                contentType = meta.contentType;
            }
            normalizedInput = await normalizeFromBuffer({
                buffer: buffer,
                ...(uploadSource.fileName ? { fileName: uploadSource.fileName } : {}),
                ...(contentType ? { contentType } : {})
            });
            effectiveFingerprint = { type: 'SHA256', value: bytesHash };
        }
        else {
            normalizedInput = await loadInputForRun(input.tenantId, run);
            effectiveFingerprint = fingerprintFromNormalizedInput(normalizedInput);
        }
        const result = runQc({
            input: normalizedInput,
            rules,
            executedAtIso: new Date().toISOString(),
            // AI signals are always optional and must be supplied by explicit service calls.
            options: { passScoreThreshold: 1, blockerFailureForcesFail: true }
        });
        const executedAt = Timestamp.fromDate(new Date(result.summary.executedAt));
        const resultId = uuidv4();
        const resultRef = db.doc(tenantSubdocPath(input.tenantId, 'qc_run_results', resultId));
        const ruleResults = result.ruleResults.map((rr, i) => mapRuleResultToDoc({
            order: i,
            rule: rules[i],
            result: rr,
            ...(run.inputSource === 'UPLOAD'
                ? {
                    source: {
                        ...(uploadSource?.storagePath ? { storagePath: uploadSource.storagePath } : {}),
                        ...(uploadSource?.fileName ? { fileName: uploadSource.fileName } : {}),
                        ...(uploadSource?.contentType ? { contentType: uploadSource.contentType } : {})
                    }
                }
                : {})
        }));
        const ruleCounts = summarizeRuleStatuses(ruleResults);
        // Prefer single atomic batch when feasible.
        const totalWritesNeeded = 1 /* result */ + ruleResults.length + 1 /* run update */;
        if (totalWritesNeeded <= 450) {
            const batch = db.batch();
            batch.create(resultRef, {
                resultId,
                tenantId: input.tenantId,
                runId: run.runId,
                createdAt: Timestamp.now(),
                engineVersion: result.summary.engineVersion,
                executedAt,
                summary: {
                    overallOutcome: result.summary.overallOutcome,
                    overallScore: result.summary.overallScore,
                    failedRuleIds: result.summary.failedRuleIds,
                    ruleCounts
                },
                integrity: {
                    ...(run.templateVersionId ? { templateVersionId: run.templateVersionId } : { templateId: run.templateId }),
                    templateVersion: run.templateVersion,
                    inputFingerprint: effectiveFingerprint
                }
            });
            for (const rr of ruleResults) {
                const rrId = uuidv4();
                const rrRef = resultRef.collection('rule_results').doc(rrId);
                batch.create(rrRef, {
                    ruleResultId: rrId,
                    ...rr
                });
            }
            batch.update(runRef, {
                status: 'SUCCEEDED',
                completedAt: Timestamp.now(),
                resultId,
                inputFingerprint: effectiveFingerprint
            });
            await batch.commit();
        }
        else {
            // Two-phase write for large rule sets: run is SUCCEEDED only after all rule docs exist.
            await resultRef.create({
                resultId,
                tenantId: input.tenantId,
                runId: run.runId,
                createdAt: Timestamp.now(),
                engineVersion: result.summary.engineVersion,
                executedAt,
                summary: {
                    overallOutcome: result.summary.overallOutcome,
                    overallScore: result.summary.overallScore,
                    failedRuleIds: result.summary.failedRuleIds,
                    ruleCounts
                },
                integrity: {
                    ...(run.templateVersionId ? { templateVersionId: run.templateVersionId } : { templateId: run.templateId }),
                    templateVersion: run.templateVersion,
                    inputFingerprint: effectiveFingerprint
                },
                writeState: 'WRITING',
                expectedRuleCount: ruleResults.length
            });
            const chunkSize = 400;
            for (let i = 0; i < ruleResults.length; i += chunkSize) {
                const batch = db.batch();
                const chunk = ruleResults.slice(i, i + chunkSize);
                for (const rr of chunk) {
                    const rrId = uuidv4();
                    const rrRef = resultRef.collection('rule_results').doc(rrId);
                    batch.create(rrRef, { ruleResultId: rrId, ...rr });
                }
                await batch.commit();
            }
            await db.runTransaction(async (tx) => {
                const latest = await tx.get(runRef);
                if (!latest.exists)
                    throw new Error('Run not found');
                const cur = latest.data();
                if (cur.status !== 'RUNNING')
                    return;
                tx.update(resultRef, { writeState: 'COMPLETE' });
                tx.update(runRef, {
                    status: 'SUCCEEDED',
                    completedAt: Timestamp.now(),
                    resultId,
                    inputFingerprint: effectiveFingerprint
                });
            });
        }
        await writeAuditLog({
            tenantId: input.tenantId,
            actorUid: input.actorUid,
            ...(input.actorRole ? { actorRole: input.actorRole } : {}),
            action: 'QC_RUN_PROCESS',
            resourceType: 'qc_run',
            resourceId: run.runId,
            meta: { resultId }
        });
    }
    catch (err) {
        const publicErr = err && typeof err === 'object' && 'category' in err && 'code' in err && 'message' in err
            ? err
            : asPublicError({
                category: 'EXECUTION',
                code: 'EXECUTION_FAILED',
                message: 'The run could not be completed.',
                help: 'Try again. If the issue persists, contact support with the run ID.',
                retryable: true
            });
        await runRef.update({
            status: 'FAILED',
            completedAt: Timestamp.now(),
            error: publicErr
        });
        await writeAuditLog({
            tenantId: input.tenantId,
            actorUid: input.actorUid,
            ...(input.actorRole ? { actorRole: input.actorRole } : {}),
            action: 'QC_RUN_PROCESS',
            resourceType: 'qc_run',
            resourceId: input.runId,
            meta: { status: 'FAILED', code: publicErr.code, category: publicErr.category }
        });
    }
}
