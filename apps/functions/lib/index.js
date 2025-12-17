import * as admin from 'firebase-admin';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
admin.initializeApp();
setGlobalOptions({ region: 'us-central1' });
import { apiApp } from './api.js';
import { processQcRun } from './lib/qcProcessor.js';
export const api = onRequest({ timeoutSeconds: 60, memory: '512MiB' }, apiApp);
// Background processing for ASYNC runs.
export const qcRunCreated = onDocumentCreated({
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
    await processQcRun({ tenantId, runId, actorUid: data.requestedByUid, actorRole: 'System' });
});
