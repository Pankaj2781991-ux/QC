import { v4 as uuidv4 } from 'uuid';

import { QcRuleDefinitionSchema, runQc } from '@qc/qc-engine';
import type { QcNormalizedInput } from '@qc/qc-engine';

import { tenantSubdocPath } from './firestorePaths.js';
import { normalizeFromBuffer, normalizeInlineJson } from './qcNormalize.js';
import { writeAuditLog } from './audit.js';
import { accessSecretString } from './secretManager.js';
import { getConnectorForIntegration } from '../connectors/registry.js';
import type { ConnectorConfig } from '@qc/shared';

import { asPublicError, type QcPublicError } from './qcPublicError.js';
import { getAdmin, Timestamp } from './firebaseAdmin.js';
import {
  fingerprintFromNormalizedInput,
  mapRuleResultToDoc,
  sha256Base16,
  summarizeRuleStatuses,
  type RunStatus
} from './qcResultMapping.js';

export type QcRunStatus = RunStatus;

export type QcRunDoc = {
  runId: string;
  tenantId: string;
  status: QcRunStatus;
  mode: 'SYNC' | 'ASYNC';
  templateId: string;
  templateVersionId: string;
  templateVersion: number;
  templateName?: string;
  inputSource: 'UPLOAD' | 'INTEGRATION' | 'INLINE';
  inputRef: {
    inline?: unknown;
    upload?: {
      storagePath: string;
      fileName?: string;
      contentType?: string;
    };
    integration?: {
      integrationId: string;
      type?: string;
      authType?: 'API_KEY' | 'OAUTH';
      query?: Record<string, unknown>;
    };
  };
  inputFingerprint?: { type: 'SHA256'; value: string };
  engineVersion: string;
  requestedAt: Timestamp;
  requestedByUid: string;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  error?: QcPublicError;
  resultId?: string;
};

type TemplateVersionDoc = {
  tenantId: string;
  templateId: string;
  version: number;
  engineVersion: string;
  ruleSnapshot: unknown[];
};

type IntegrationDoc = {
  tenantId: string;
  type: string;
  authType: 'API_KEY' | 'OAUTH';
  config: Record<string, unknown>;
  credentialsRef?: {
    secretResourceName: string;
  };
};

async function fetchTemplateVersion(tenantId: string, templateVersionId: string): Promise<TemplateVersionDoc> {
  const { db } = getAdmin();
  const snap = await db.doc(tenantSubdocPath(tenantId, 'qc_template_versions', templateVersionId)).get();
  if (!snap.exists) throw new Error('Template version not found');
  return snap.data() as TemplateVersionDoc;
}

async function loadInputForRun(tenantId: string, run: QcRunDoc): Promise<QcNormalizedInput> {
  if (run.inputSource === 'INLINE') {
    return normalizeInlineJson(run.inputRef.inline);
  }

  if (run.inputSource === 'UPLOAD') {
    if (!run.inputRef.upload?.storagePath) throw new Error('Missing storagePath');

    const { storage } = getAdmin();
    const bucket = storage.bucket();
    const file = bucket.file(run.inputRef.upload.storagePath);
    const [buffer] = await file.download();

    // Attempt to use stored metadata if present.
    let contentType: string | undefined = run.inputRef.upload.contentType;
    if (!contentType) {
      const [meta] = await file.getMetadata();
      contentType = meta.contentType;
    }

    return normalizeFromBuffer({
      buffer: buffer as Buffer,
      ...(run.inputRef.upload.fileName ? { fileName: run.inputRef.upload.fileName } : {}),
      ...(contentType ? { contentType } : {})
    });
  }

  if (run.inputSource === 'INTEGRATION') {
    if (!run.inputRef.integration?.integrationId) throw new Error('Missing integrationId');

    const { db } = getAdmin();
    const snap = await db.doc(tenantSubdocPath(tenantId, 'integrations', run.inputRef.integration.integrationId)).get();
    if (!snap.exists) throw new Error('Integration not found');

    const integration = snap.data() as IntegrationDoc;
    const connectorConfig: ConnectorConfig = {
      tenantId,
      integrationId: snap.id,
      type: integration.type,
      authType: integration.authType,
      config: integration.config ?? {}
    };

    const connector = getConnectorForIntegration(connectorConfig);

    const credentials: Record<string, unknown> = {};
    if (connectorConfig.authType === 'API_KEY') {
      const secretName = integration.credentialsRef?.secretResourceName;
      if (!secretName) throw new Error('Missing credentialsRef.secretResourceName');
      credentials.apiKey = await accessSecretString(secretName);
    } else {
      throw new Error('OAuth credentials not implemented yet');
    }

    const normalized = await connector.fetchStructuredData({
      config: connectorConfig,
      credentials,
      ...(run.inputRef.integration.query ? { query: run.inputRef.integration.query } : {})
    });

    if (normalized.kind === 'text') return { kind: 'text', text: normalized.text };
    if (normalized.kind === 'record') return { kind: 'record', record: normalized.record };
    if (normalized.kind === 'table') return { kind: 'table', columns: normalized.columns, rows: normalized.rows };

    return { kind: 'record', record: { value: normalized } };
  }

  throw new Error(`Unsupported inputSource: ${run.inputSource}`);
}

export async function processQcRun(input: { tenantId: string; runId: string; actorUid: string; actorRole?: string }) {
  const { db, storage } = getAdmin();
  const runRef = db.doc(tenantSubdocPath(input.tenantId, 'qc_runs', input.runId));

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(runRef);
    if (!snap.exists) throw new Error('Run not found');
    const run = snap.data() as QcRunDoc;

    if (run.status === 'CANCELLED') return;
    if (run.status !== 'QUEUED') return;

    tx.update(runRef, { status: 'RUNNING', startedAt: Timestamp.now() });
  });

  const runSnap = await runRef.get();
  const run = runSnap.data() as QcRunDoc;
  if (run.status !== 'RUNNING') return;

  try {
    const templateVersion = await fetchTemplateVersion(input.tenantId, run.templateVersionId);
    const rules = templateVersion.ruleSnapshot.map((r) => QcRuleDefinitionSchema.parse(r) as any);

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

    let normalizedInput: QcNormalizedInput;
    let effectiveFingerprint: { type: 'SHA256'; value: string };

    if (run.inputSource === 'UPLOAD') {
      const storagePath = uploadSource!.storagePath;
      const bucket = storage.bucket();
      const file = bucket.file(storagePath);
      const [buffer] = await file.download();
      const bytesHash = sha256Base16(buffer as Buffer);

      // Use run-provided metadata if available; otherwise fetch from object metadata.
      let contentType: string | undefined = uploadSource!.contentType;
      if (!contentType) {
        const [meta] = await file.getMetadata();
        contentType = meta.contentType;
      }

      normalizedInput = await normalizeFromBuffer({
        buffer: buffer as Buffer,
        ...(uploadSource!.fileName ? { fileName: uploadSource!.fileName } : {}),
        ...(contentType ? { contentType } : {})
      });
      effectiveFingerprint = { type: 'SHA256', value: bytesHash };
    } else {
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
    const ruleResults = result.ruleResults.map((rr, i) =>
      mapRuleResultToDoc({
        order: i,
        rule: rules[i]!,
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
      })
    );
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
          templateVersionId: run.templateVersionId,
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
    } else {
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
          templateVersionId: run.templateVersionId,
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
        if (!latest.exists) throw new Error('Run not found');
        const cur = latest.data() as QcRunDoc;
        if (cur.status !== 'RUNNING') return;
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
  } catch (err) {
    const publicErr: QcPublicError =
      err && typeof err === 'object' && 'category' in (err as any) && 'code' in (err as any) && 'message' in (err as any)
        ? (err as QcPublicError)
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
