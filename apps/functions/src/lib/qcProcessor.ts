import { v4 as uuidv4 } from 'uuid';

import { QcRuleDefinitionSchema, QC_ENGINE_VERSION, runQc } from '@qc/qc-engine';
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

import { splitTranscriptIntoChats, type ChatSegment, type ChatSplitStrategy } from './qcChatSplit.js';

export type QcRunStatus = RunStatus;

type ChatResultSummary = {
  index: number;
  title: string;
  chatId?: string;
  participants?: { operator?: string; customer?: string };
  summary: {
    overallOutcome: 'PASS' | 'FAIL';
    overallScore: number;
    failedRuleIds: string[];
    ruleCounts: { total: number; pass: number; fail: number; notEvaluated: number; error: number };
  };
};

type PerChatComputed = {
  chat: ChatSegment;
  summary: ChatResultSummary['summary'];
  ruleDocs: ReturnType<typeof mapRuleResultToDoc>[];
};

function combineAggregatedRuleDocs(perChatRuleDocs: Array<{ chat: ChatSegment; docs: ReturnType<typeof mapRuleResultToDoc>[] }>) {
  if (!perChatRuleDocs.length) return [] as ReturnType<typeof mapRuleResultToDoc>[];

  const ruleCount = perChatRuleDocs[0]!.docs.length;
  const out: ReturnType<typeof mapRuleResultToDoc>[] = [];

  const statusRank: Record<string, number> = { NOT_EVALUATED: 0, PASS: 1, FAIL: 2, ERROR: 3 };
  const rankToStatus = (rank: number): any => {
    if (rank >= 3) return 'ERROR';
    if (rank === 2) return 'FAIL';
    if (rank === 1) return 'PASS';
    return 'NOT_EVALUATED';
  };

  for (let i = 0; i < ruleCount; i++) {
    const entries = perChatRuleDocs.map((x) => ({ chat: x.chat, doc: x.docs[i]! }));
    const worstRank = Math.max(...entries.map((e) => statusRank[e.doc.status] ?? 0));
    const status = rankToStatus(worstRank);
    const score = Math.min(...entries.map((e) => Number.isFinite(e.doc.score) ? e.doc.score : 0));

    const reason =
      status === 'FAIL' || status === 'NOT_EVALUATED'
        ? entries.find((e) => (e.doc.status === status || (status === 'FAIL' && e.doc.status === 'FAIL')) && e.doc.reason)?.doc.reason
        : undefined;

    const evidence: any[] = [];
    for (const e of entries) {
      if (e.doc.status !== status && !(status === 'FAIL' && e.doc.status === 'FAIL')) continue;
      const prefix = `Chat ${e.chat.index + 1}${e.chat.title ? ` (${e.chat.title})` : ''}: `;
      for (const ev of e.doc.evidence ?? []) {
        if (evidence.length >= 25) break;
        evidence.push({ ...ev, detail: ev.detail ? `${prefix}${ev.detail}` : prefix.trimEnd() });
      }
      if (evidence.length >= 25) break;
    }

    const base = entries[0]!.doc;
    out.push({
      ...base,
      status,
      score,
      ...(reason ? { reason } : {}),
      evidence
    });
  }

  return out;
}

function combineRunSummaryFromChats(chatSummaries: ChatResultSummary[]) {
  const overallOutcome: 'PASS' | 'FAIL' = chatSummaries.some((c) => c.summary.overallOutcome === 'FAIL') ? 'FAIL' : 'PASS';
  const overallScore = chatSummaries.length ? Math.min(...chatSummaries.map((c) => c.summary.overallScore)) : 1;

  const failedRuleIds = Array.from(
    new Set(chatSummaries.flatMap((c) => c.summary.failedRuleIds ?? []).filter((x) => typeof x === 'string'))
  );

  return { overallOutcome, overallScore, failedRuleIds };
}

export type QcRunDoc = {
  runId: string;
  tenantId: string;
  status: QcRunStatus;
  mode: 'SYNC' | 'ASYNC';
  templateId: string;
  templateVersionId?: string;
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

async function fetchTemplateRules(tenantId: string, templateId: string): Promise<unknown[]> {
  const { db } = getAdmin();
  const snap = await db.doc(tenantSubdocPath(tenantId, 'qc_templates', templateId)).get();
  if (!snap.exists) throw new Error('Template not found');
  const data = snap.data() as any;
  return data?.rules ?? [];
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
    // Fetch rules - from version if provided, otherwise from template directly
    let ruleSnapshot: unknown[];
    if (run.templateVersionId) {
      const templateVersion = await fetchTemplateVersion(input.tenantId, run.templateVersionId);
      ruleSnapshot = templateVersion.ruleSnapshot;
    } else {
      ruleSnapshot = await fetchTemplateRules(input.tenantId, run.templateId);
    }
    const rules = ruleSnapshot.map((r) => QcRuleDefinitionSchema.parse(r) as any);

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

    const executedAtIso = new Date().toISOString();

    const sourceForEvidence =
      run.inputSource === 'UPLOAD'
        ? {
            source: {
              ...(uploadSource?.storagePath ? { storagePath: uploadSource.storagePath } : {}),
              ...(uploadSource?.fileName ? { fileName: uploadSource.fileName } : {}),
              ...(uploadSource?.contentType ? { contentType: uploadSource.contentType } : {})
            }
          }
        : {};

    // If input is text, attempt to split into multiple chats and evaluate each chat separately.
    const split = normalizedInput.kind === 'text' ? splitTranscriptIntoChats(normalizedInput.text) : null;
    const multiChatEnabled = Boolean(split && split.chats.length >= 2);

    let resultId = uuidv4();
    const resultRef = db.doc(tenantSubdocPath(input.tenantId, 'qc_run_results', resultId));

    let aggregatedRuleDocs: ReturnType<typeof mapRuleResultToDoc>[];
    let ruleCounts: { total: number; pass: number; fail: number; notEvaluated: number; error: number };
    let runSummary: { overallOutcome: 'PASS' | 'FAIL'; overallScore: number; failedRuleIds: string[] };
    let chatSummaries: ChatResultSummary[] | null = null;
    let perChatComputed: PerChatComputed[] | null = null;
    let chatMeta: { enabled: boolean; strategy: ChatSplitStrategy; chatCount: number; warning?: string } | null = null;
    let executedAt: Timestamp;

    if (multiChatEnabled) {
      const chats = split!.chats;

      perChatComputed = chats.map((chat) => {
        const chatResult = runQc({
          input: { kind: 'text', text: chat.text },
          rules,
          executedAtIso,
          options: { passScoreThreshold: 1, blockerFailureForcesFail: true }
        });
        const docs = chatResult.ruleResults.map((rr, i) =>
          mapRuleResultToDoc({
            order: i,
            rule: rules[i]!,
            result: rr,
            ...sourceForEvidence,
            contextPrefix: ''
          })
        );
        const counts = summarizeRuleStatuses(docs);
        return {
          chat,
          summary: {
            overallOutcome: chatResult.summary.overallOutcome,
            overallScore: chatResult.summary.overallScore,
            failedRuleIds: chatResult.summary.failedRuleIds,
            ruleCounts: counts
          },
          ruleDocs: docs
        };
      });

      // Use the first executedAt (all use the same executedAtIso, but qc-engine echoes it back).
      executedAt = Timestamp.fromDate(new Date(executedAtIso));

      chatSummaries = perChatComputed.map((c) => ({
        index: c.chat.index,
        title: c.chat.title,
        ...(c.chat.chatId ? { chatId: c.chat.chatId } : {}),
        ...(c.chat.participants ? { participants: c.chat.participants } : {}),
        summary: c.summary
      }));

      aggregatedRuleDocs = combineAggregatedRuleDocs(perChatComputed.map((c) => ({ chat: c.chat, docs: c.ruleDocs })));
      ruleCounts = summarizeRuleStatuses(aggregatedRuleDocs);
      runSummary = combineRunSummaryFromChats(chatSummaries);
      chatMeta = { enabled: true, strategy: split!.strategy, chatCount: chats.length, ...(split!.warning ? { warning: split!.warning } : {}) };
    } else {
      const result = runQc({
        input: normalizedInput,
        rules,
        executedAtIso,
        // AI signals are always optional and must be supplied by explicit service calls.
        options: { passScoreThreshold: 1, blockerFailureForcesFail: true }
      });

      executedAt = Timestamp.fromDate(new Date(result.summary.executedAt));
      aggregatedRuleDocs = result.ruleResults.map((rr, i) =>
        mapRuleResultToDoc({
          order: i,
          rule: rules[i]!,
          result: rr,
          ...sourceForEvidence
        })
      );
      ruleCounts = summarizeRuleStatuses(aggregatedRuleDocs);
      runSummary = {
        overallOutcome: result.summary.overallOutcome,
        overallScore: result.summary.overallScore,
        failedRuleIds: result.summary.failedRuleIds
      };
      chatMeta = split && split.warning ? { enabled: false, strategy: split.strategy, chatCount: 1, warning: split.warning } : null;
    }

    // Prefer single atomic batch when feasible (single-chat only).
    const totalWritesNeeded = 1 /* result */ + aggregatedRuleDocs.length + 1 /* run update */;
    const canSingleBatch = !multiChatEnabled && totalWritesNeeded <= 450;

    if (canSingleBatch) {
      const batch = db.batch();
      batch.create(resultRef, {
        resultId,
        tenantId: input.tenantId,
        runId: run.runId,
        createdAt: Timestamp.now(),
        engineVersion: QC_ENGINE_VERSION,
        executedAt,
        summary: {
          overallOutcome: runSummary.overallOutcome,
          overallScore: runSummary.overallScore,
          failedRuleIds: runSummary.failedRuleIds,
          ruleCounts
        },
        integrity: {
          ...(run.templateVersionId ? { templateVersionId: run.templateVersionId } : { templateId: run.templateId }),
          templateVersion: run.templateVersion,
          inputFingerprint: effectiveFingerprint
        },
        ...(chatMeta ? { chat: chatMeta } : {})
      });

      for (const rr of aggregatedRuleDocs) {
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
      // Two-phase write for large rule sets OR multi-chat: run is SUCCEEDED only after all docs exist.
      await resultRef.create({
        resultId,
        tenantId: input.tenantId,
        runId: run.runId,
        createdAt: Timestamp.now(),
        engineVersion: QC_ENGINE_VERSION,
        executedAt,
        summary: {
          overallOutcome: runSummary.overallOutcome,
          overallScore: runSummary.overallScore,
          failedRuleIds: runSummary.failedRuleIds,
          ruleCounts
        },
        integrity: {
          ...(run.templateVersionId ? { templateVersionId: run.templateVersionId } : { templateId: run.templateId }),
          templateVersion: run.templateVersion,
          inputFingerprint: effectiveFingerprint
        },
        ...(chatMeta ? { chat: chatMeta } : {}),
        writeState: 'WRITING',
        expectedRuleCount: aggregatedRuleDocs.length
      });

      const chunkSize = 400;
      for (let i = 0; i < aggregatedRuleDocs.length; i += chunkSize) {
        const batch = db.batch();
        const chunk = aggregatedRuleDocs.slice(i, i + chunkSize);
        for (const rr of chunk) {
          const rrId = uuidv4();
          const rrRef = resultRef.collection('rule_results').doc(rrId);
          batch.create(rrRef, { ruleResultId: rrId, ...rr });
        }
        await batch.commit();
      }

      if (multiChatEnabled && chatSummaries) {
        // Write chat summaries + per-chat rule_results.
        for (const chat of chatSummaries) {
          const chatResultId = uuidv4();
          const chatRef = resultRef.collection('chat_results').doc(chatResultId);
          await chatRef.create({
            chatResultId,
            index: chat.index,
            title: chat.title,
            ...(chat.chatId ? { chatId: chat.chatId } : {}),
            ...(chat.participants ? { participants: chat.participants } : {}),
            summary: chat.summary,
            createdAt: Timestamp.now()
          });

          const found = perChatComputed?.find((c) => c.chat.index === chat.index);
          const perDocs = found?.ruleDocs ?? [];

          for (let i = 0; i < perDocs.length; i += chunkSize) {
            const batch = db.batch();
            const chunk = perDocs.slice(i, i + chunkSize);
            for (const rr of chunk) {
              const rrId = uuidv4();
              const rrRef = chatRef.collection('rule_results').doc(rrId);
              batch.create(rrRef, { ruleResultId: rrId, ...rr });
            }
            await batch.commit();
          }
        }
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
