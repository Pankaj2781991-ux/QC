import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
setGlobalOptions({ region: 'us-central1' });
// IMPORTANT: Keep module initialization fast.
// Firebase CLI loads this file to discover exported functions during deploy.
// Avoid heavy imports here; lazy-load inside handlers.
export const api = onRequest({ timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
    const { apiApp } = await import('./api.js');
    return apiApp(req, res);
});
// Background processing for ASYNC runs.
export const qcRunCreatedV2 = onDocumentCreated({
    document: 'tenants/{tenantId}/qc_runs/{runId}',
    timeoutSeconds: 540,
    memory: '1GiB'
}, async (event) => {
    const tenantId = event.params.tenantId;
    const runId = event.params.runId;
    const data = event.data?.data();
    if (!data)
        return;
    // Only process ASYNC automatically. SYNC is processed inline by API.
    if (data.mode !== 'ASYNC')
        return;
    const { processQcRun } = await import('./lib/qcProcessor.js');
    await processQcRun({ tenantId, runId, actorUid: data.requestedByUid, actorRole: 'System' });
});
