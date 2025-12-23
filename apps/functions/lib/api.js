import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { QcRuleDefinitionSchema, QC_ENGINE_VERSION } from '@qc/qc-engine';
import { asyncHandler, errorMiddleware } from './lib/http.js';
import { ApiError } from './lib/errors.js';
import { requireAuth, requireRole } from './lib/auth.js';
import { tenantDocPath, tenantSubdocPath, tenantSubcollectionPath } from './lib/firestorePaths.js';
import { writeAuditLog } from './lib/audit.js';
import { processQcRun } from './lib/qcProcessor.js';
import { storeApiKeySecret } from './lib/secretManager.js';
import { getAdmin, Timestamp } from './lib/firebaseAdmin.js';
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});
// Bootstrap: creates tenant + user membership doc + sets custom claims.
app.post('/v1/tenants/bootstrap', asyncHandler(async (req, res) => {
    const { auth: adminAuth, db } = getAdmin();
    const authorization = req.header('authorization');
    if (!authorization?.startsWith('Bearer '))
        throw new ApiError('UNAUTHENTICATED', 'Missing Bearer token', 401);
    const idToken = authorization.slice('Bearer '.length).trim();
    const token = await adminAuth.verifyIdToken(idToken);
    const existingTenant = token.tenantId;
    if (existingTenant)
        throw new ApiError('FAILED_PRECONDITION', 'User already provisioned for a tenant', 412);
    const bodySchema = z.object({ tenantName: z.string().min(2).max(128) });
    const body = bodySchema.parse(req.body);
    const tenantId = uuidv4();
    const tenantRef = db.doc(tenantDocPath(tenantId));
    const userRef = db.doc(tenantSubdocPath(tenantId, 'users', token.uid));
    await db.runTransaction(async (tx) => {
        tx.create(tenantRef, {
            name: body.tenantName,
            status: 'active',
            createdAt: Timestamp.now(),
            createdByUid: token.uid
        });
        tx.create(userRef, {
            uid: token.uid,
            tenantId,
            email: token.email ?? null,
            role: 'Admin',
            status: 'active',
            createdAt: Timestamp.now()
        });
    });
    await adminAuth.setCustomUserClaims(token.uid, { tenantId, role: 'Admin' });
    await writeAuditLog({
        tenantId,
        actorUid: token.uid,
        actorRole: 'Admin',
        action: 'TENANT_BOOTSTRAP',
        resourceType: 'tenant',
        resourceId: tenantId,
        meta: { tenantName: body.tenantName }
    });
    res.json({ tenantId });
}));
app.get('/v1/templates', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    const { db } = getAdmin();
    const snap = await db.collection(tenantSubcollectionPath(auth.tenantId, 'qc_templates')).get();
    res.json({ templates: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
}));
app.get('/v1/templates/:templateId/versions', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Viewer');
    const templateId = req.params.templateId;
    if (!templateId)
        throw new ApiError('INVALID_ARGUMENT', 'templateId is required', 400);
    const { db } = getAdmin();
    // NOTE: A (templateId ASC, version DESC) composite index is recommended for this query.
    // Some environments/users may not have permission to deploy Firestore indexes via CLI.
    // To keep the UI working, fetch a bounded set and sort in memory.
    const snap = await db
        .collection(tenantSubcollectionPath(auth.tenantId, 'qc_template_versions'))
        .where('templateId', '==', templateId)
        .limit(200)
        .get();
    const versions = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (Number(b.version ?? 0) || 0) - (Number(a.version ?? 0) || 0))
        .slice(0, 25);
    res.json({ versions });
}));
app.get('/v1/integrations', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Manager');
    const { db } = getAdmin();
    const snap = await db.collection(tenantSubcollectionPath(auth.tenantId, 'integrations')).get();
    res.json({ integrations: snap.docs.map((d) => ({ id: d.id, ...d.data(), credentialsRef: undefined })) });
}));
app.post('/v1/integrations', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Manager');
    const { db } = getAdmin();
    const bodySchema = z.object({
        type: z.string().min(1),
        authType: z.enum(['API_KEY', 'OAUTH']),
        config: z.record(z.unknown()).default({}),
        apiKey: z.string().min(8).optional()
    });
    const body = bodySchema.parse(req.body);
    const integrationId = uuidv4();
    const projectId = process.env.GCLOUD_PROJECT;
    if (!projectId)
        throw new ApiError('FAILED_PRECONDITION', 'GCLOUD_PROJECT env var not set', 412);
    let credentialsRef;
    if (body.authType === 'API_KEY') {
        if (!body.apiKey)
            throw new ApiError('INVALID_ARGUMENT', 'apiKey required for API_KEY integrations', 400);
        const stored = await storeApiKeySecret({
            projectId,
            tenantId: auth.tenantId,
            integrationId,
            apiKey: body.apiKey
        });
        credentialsRef = { secretResourceName: stored.secretResourceName };
    }
    const ref = db.doc(tenantSubdocPath(auth.tenantId, 'integrations', integrationId));
    await ref.create({
        tenantId: auth.tenantId,
        type: body.type,
        authType: body.authType,
        config: body.config,
        ...(credentialsRef ? { credentialsRef } : {}),
        createdAt: Timestamp.now(),
        createdByUid: auth.uid,
        updatedAt: Timestamp.now()
    });
    await writeAuditLog({
        tenantId: auth.tenantId,
        actorUid: auth.uid,
        actorRole: auth.role,
        action: 'INTEGRATION_CREATE',
        resourceType: 'integration',
        resourceId: integrationId,
        meta: { type: body.type, authType: body.authType }
    });
    res.json({ integrationId });
}));
app.post('/v1/templates', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Manager');
    const { db } = getAdmin();
    const bodySchema = z.object({ name: z.string().min(2).max(128), description: z.string().max(2048).optional() });
    const body = bodySchema.parse(req.body);
    const id = uuidv4();
    const ref = db.doc(tenantSubdocPath(auth.tenantId, 'qc_templates', id));
    await ref.create({
        templateId: id,
        tenantId: auth.tenantId,
        name: body.name,
        description: body.description ?? null,
        currentVersion: 0,
        createdAt: Timestamp.now(),
        createdByUid: auth.uid,
        updatedAt: Timestamp.now()
    });
    await writeAuditLog({
        tenantId: auth.tenantId,
        actorUid: auth.uid,
        actorRole: auth.role,
        action: 'TEMPLATE_CREATE',
        resourceType: 'qc_template',
        resourceId: id
    });
    res.json({ templateId: id });
}));
app.post('/v1/templates/:templateId/versions', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Manager');
    const { db } = getAdmin();
    const templateId = req.params.templateId;
    if (!templateId)
        throw new ApiError('INVALID_ARGUMENT', 'templateId is required', 400);
    const bodySchema = z.object({
        ruleSnapshot: z.array(z.unknown()).min(1)
    });
    const body = bodySchema.parse(req.body);
    // Validate rule JSON deterministically.
    const rules = body.ruleSnapshot.map((r) => QcRuleDefinitionSchema.parse(r));
    const templateRef = db.doc(tenantSubdocPath(auth.tenantId, 'qc_templates', templateId));
    const templateSnap = await templateRef.get();
    if (!templateSnap.exists)
        throw new ApiError('NOT_FOUND', 'Template not found', 404);
    const currentVersion = templateSnap.data()?.currentVersion ?? 0;
    const nextVersion = currentVersion + 1;
    const versionId = uuidv4();
    const versionRef = db.doc(tenantSubdocPath(auth.tenantId, 'qc_template_versions', versionId));
    await db.runTransaction(async (tx) => {
        tx.create(versionRef, {
            tenantId: auth.tenantId,
            templateId,
            version: nextVersion,
            engineVersion: '0.1.0',
            ruleSnapshot: rules,
            createdAt: Timestamp.now(),
            createdByUid: auth.uid
        });
        tx.update(templateRef, { currentVersion: nextVersion, updatedAt: Timestamp.now() });
    });
    await writeAuditLog({
        tenantId: auth.tenantId,
        actorUid: auth.uid,
        actorRole: auth.role,
        action: 'TEMPLATE_VERSION_CREATE',
        resourceType: 'qc_template_version',
        resourceId: versionId,
        meta: { templateId: req.params.templateId, version: nextVersion }
    });
    res.json({ templateVersionId: versionId, version: nextVersion });
}));
app.post('/v1/qc-runs', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Viewer');
    const { db } = getAdmin();
    const bodySchema = z.object({
        runId: z.string().uuid().optional(),
        mode: z.enum(['SYNC', 'ASYNC']).default('SYNC'),
        templateId: z.string().min(1),
        templateVersionId: z.string().min(1),
        inputSource: z.enum(['INLINE', 'UPLOAD', 'INTEGRATION']),
        input: z.unknown().optional(),
        upload: z
            .object({
            storagePath: z.string().min(1),
            fileName: z.string().min(1).optional(),
            contentType: z.string().min(1).optional()
        })
            .optional(),
        integration: z
            .object({
            integrationId: z.string().min(1),
            query: z.record(z.unknown()).optional()
        })
            .optional()
    });
    const body = bodySchema.parse(req.body);
    const runId = body.runId ?? uuidv4();
    const runRef = db.doc(tenantSubdocPath(auth.tenantId, 'qc_runs', runId));
    // Enforce deterministic upload addressing.
    if (body.inputSource === 'UPLOAD' && !body.runId) {
        throw new ApiError('INVALID_ARGUMENT', 'runId is required for UPLOAD runs to ensure deterministic storage paths', 400);
    }
    const templateRef = db.doc(tenantSubdocPath(auth.tenantId, 'qc_templates', body.templateId));
    const templateSnap = await templateRef.get();
    if (!templateSnap.exists)
        throw new ApiError('NOT_FOUND', 'Template not found', 404);
    const templateName = String(templateSnap.data()?.name ?? '');
    if (!templateName)
        throw new ApiError('FAILED_PRECONDITION', 'Template name missing', 412);
    // Template version is required; templateVersion number is read from the version doc.
    const versionSnap = await db.doc(tenantSubdocPath(auth.tenantId, 'qc_template_versions', body.templateVersionId)).get();
    if (!versionSnap.exists)
        throw new ApiError('NOT_FOUND', 'Template version not found', 404);
    const versionData = versionSnap.data();
    const version = versionData?.version ?? 0;
    const versionTemplateId = versionData?.templateId;
    if (versionTemplateId && versionTemplateId !== body.templateId) {
        throw new ApiError('INVALID_ARGUMENT', 'templateVersionId does not belong to templateId', 400);
    }
    const inputRef = body.inputSource === 'INLINE'
        ? { inline: body.input }
        : body.inputSource === 'UPLOAD'
            ? {
                upload: {
                    storagePath: body.upload?.storagePath,
                    fileName: body.upload?.fileName,
                    contentType: body.upload?.contentType
                }
            }
            : {
                integration: {
                    integrationId: body.integration?.integrationId,
                    query: body.integration?.query
                }
            };
    if (body.inputSource === 'UPLOAD' && !inputRef.upload?.storagePath) {
        throw new ApiError('INVALID_ARGUMENT', 'upload.storagePath is required for UPLOAD', 400);
    }
    if (body.inputSource === 'UPLOAD') {
        const expectedPrefix = `tenants/${auth.tenantId}/uploads/${runId}/`;
        if (!String(inputRef.upload?.storagePath ?? '').startsWith(expectedPrefix)) {
            throw new ApiError('INVALID_ARGUMENT', `upload.storagePath must start with ${expectedPrefix}`, 400);
        }
    }
    if (body.inputSource === 'INTEGRATION' && !inputRef.integration?.integrationId) {
        throw new ApiError('INVALID_ARGUMENT', 'integration.integrationId is required for INTEGRATION', 400);
    }
    // Snapshot integration metadata for audit/reproducibility.
    let integrationSnapshot = null;
    if (body.inputSource === 'INTEGRATION') {
        const integrationId = String(inputRef.integration?.integrationId ?? '');
        const snap = await db.doc(tenantSubdocPath(auth.tenantId, 'integrations', integrationId)).get();
        if (!snap.exists)
            throw new ApiError('NOT_FOUND', 'Integration not found', 404);
        const data = snap.data();
        integrationSnapshot = {
            integrationId,
            type: String(data?.type ?? ''),
            authType: data?.authType === 'OAUTH' ? 'OAUTH' : 'API_KEY',
            ...(inputRef.integration?.query ? { query: inputRef.integration.query } : {})
        };
    }
    await runRef.create({
        runId,
        tenantId: auth.tenantId,
        status: 'QUEUED',
        mode: body.mode,
        templateId: body.templateId,
        templateName,
        templateVersionId: body.templateVersionId,
        templateVersion: version,
        inputSource: body.inputSource,
        inputRef: body.inputSource === 'INTEGRATION'
            ? {
                integration: integrationSnapshot
            }
            : inputRef,
        engineVersion: QC_ENGINE_VERSION,
        requestedAt: Timestamp.now(),
        requestedByUid: auth.uid
    });
    await writeAuditLog({
        tenantId: auth.tenantId,
        actorUid: auth.uid,
        actorRole: auth.role,
        action: 'QC_RUN_CREATE',
        resourceType: 'qc_run',
        resourceId: runId,
        meta: { mode: body.mode, inputSource: body.inputSource, templateVersionId: body.templateVersionId }
    });
    if (body.mode === 'SYNC') {
        // Synchronous: process immediately.
        await processQcRun({ tenantId: auth.tenantId, runId, actorUid: auth.uid, actorRole: auth.role });
    }
    res.json({ runId });
}));
app.get('/v1/qc-runs/:runId', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    const { db } = getAdmin();
    const runId = req.params.runId;
    if (!runId)
        throw new ApiError('INVALID_ARGUMENT', 'runId is required', 400);
    const runSnap = await db.doc(tenantSubdocPath(auth.tenantId, 'qc_runs', runId)).get();
    if (!runSnap.exists)
        throw new ApiError('NOT_FOUND', 'Run not found', 404);
    const run = runSnap.data();
    let resultSummary = null;
    if (run.resultId) {
        const resultSnap = await db.doc(tenantSubdocPath(auth.tenantId, 'qc_run_results', String(run.resultId))).get();
        resultSummary = resultSnap.exists ? { id: resultSnap.id, ...resultSnap.data() } : null;
    }
    res.json({ run: { id: runSnap.id, ...run }, resultSummary });
}));
app.get('/v1/qc-runs/:runId/rule-results', asyncHandler(async (req, res) => {
    const auth = await requireAuth(req.header('authorization'));
    requireRole(auth.role, 'Viewer');
    const { db } = getAdmin();
    const runId = req.params.runId;
    if (!runId)
        throw new ApiError('INVALID_ARGUMENT', 'runId is required', 400);
    const querySchema = z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        startAfter: z.coerce.number().int().min(-1).default(-1)
    });
    const q = querySchema.parse(req.query);
    const runSnap = await db.doc(tenantSubdocPath(auth.tenantId, 'qc_runs', runId)).get();
    if (!runSnap.exists)
        throw new ApiError('NOT_FOUND', 'Run not found', 404);
    const run = runSnap.data();
    const resultId = run.resultId;
    if (!resultId)
        throw new ApiError('FAILED_PRECONDITION', 'Run has no results yet', 412);
    const coll = db.collection(tenantSubcollectionPath(auth.tenantId, `qc_run_results/${resultId}/rule_results`));
    let query = coll.orderBy('order', 'asc').limit(q.limit);
    if (q.startAfter >= 0)
        query = query.startAfter(q.startAfter);
    const snap = await query.get();
    const ruleResults = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const lastOrder = snap.docs.length ? snap.docs[snap.docs.length - 1].data().order : null;
    res.json({ ruleResults, nextStartAfter: lastOrder });
}));
app.use(errorMiddleware);
export { app as apiApp };
