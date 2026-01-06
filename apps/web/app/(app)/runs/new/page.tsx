'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import { useRouter } from 'next/navigation';

import { useAuth } from '../../../../lib/auth';
import { createAuthedClient } from '../../../../lib/api';
import { getFirebaseStorage } from '../../../../lib/firebase';

type Template = {
  id: string;
  templateId?: string;
  name?: string;
  rules?: unknown[];
};

type TemplatesListResponse = {
  templates: Template[];
};

type Integration = {
  id: string;
  type?: string;
  authType?: 'API_KEY' | 'OAUTH';
  config?: Record<string, unknown>;
  updatedAt?: unknown;
};

type IntegrationsListResponse = {
  integrations: Integration[];
};

type CreateRunResponse = {
  runId: string;
};

type RunGetResponse = {
  run: {
    id: string;
    runId: string;
    status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    mode: 'SYNC' | 'ASYNC';
    templateId: string;
    templateVersion: number;
    inputSource: 'UPLOAD' | 'INTEGRATION' | 'INLINE';
    error?: { message: string };
    resultId?: string;
  };
  resultSummary: any | null;
};

export default function RunNewPage() {
  const { user, claims, loading } = useAuth();
  const router = useRouter();

  const [templates, setTemplates] = useState<Template[]>([]);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);

  const [inputSource, setInputSource] = useState<'UPLOAD' | 'INTEGRATION'>('UPLOAD');

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>('');
  const [integrationQueryText, setIntegrationQueryText] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runId, setRunId] = useState<string>('');
  const [runStatus, setRunStatus] = useState<RunGetResponse['run']['status'] | null>(null);
  const [runOutcome, setRunOutcome] = useState<string | null>(null);
  const [runScore, setRunScore] = useState<number | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  const canRun = useMemo(() => Boolean(user && claims.tenantId), [user, claims.tenantId]);

  // Check if selected template has rules
  const selectedTemplate = templates.find((t) => (t.templateId ?? t.id) === selectedTemplateId);
  const hasRules = selectedTemplate && Array.isArray(selectedTemplate.rules) && selectedTemplate.rules.length > 0;

  async function loadTemplates() {
    if (!user) return;
    const client = await createAuthedClient(user);
    const resp = await client.request<TemplatesListResponse>('/v1/templates');
    setTemplates(resp.templates ?? []);
  }

  async function loadIntegrations() {
    if (!user) return;
    setIntegrationsError(null);
    try {
      const client = await createAuthedClient(user);
      const resp = await client.request<IntegrationsListResponse>('/v1/integrations');
      setIntegrations(resp.integrations ?? []);
    } catch (e) {
      // Integrations are role-gated (Manager+). Keep upload flow working even if this fails.
      setIntegrations([]);
      setIntegrationsError(e instanceof Error ? e.message : 'Unable to load integrations');
    }
  }

  async function pollOnce(id: string) {
    if (!user) return;
    const client = await createAuthedClient(user);
    const resp = await client.request<RunGetResponse>(`/v1/qc-runs/${encodeURIComponent(id)}`);
    setRunStatus(resp.run.status);
    setRunOutcome(resp.resultSummary?.summary?.overallOutcome ?? null);
    setRunScore(typeof resp.resultSummary?.summary?.overallScore === 'number' ? resp.resultSummary.summary.overallScore : null);

    if (resp.run.status === 'SUCCEEDED' || resp.run.status === 'FAILED' || resp.run.status === 'CANCELLED') {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      if (resp.run.status === 'SUCCEEDED') {
        router.push(`/runs/${encodeURIComponent(id)}`);
      }
    }
  }

  useEffect(() => {
    if (!loading && canRun) {
      void loadTemplates().catch((e) => setError(e instanceof Error ? e.message : 'Unknown error'));
      void loadIntegrations();
    }

    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [loading, canRun]);

  if (loading) return <div>Loading…</div>;
  if (!user) return null;

  if (!claims.tenantId) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h1 className="text-2xl font-semibold text-zinc-950">Run QC</h1>
        <p className="mt-2 text-sm text-zinc-600">You must bootstrap/join a tenant first.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">Run QC</h1>
        <p className="mt-1 text-sm text-zinc-600">Select a template and provide input (upload or integration) to run QC checks.</p>
      </div>

      {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <div className="rounded-lg border bg-white p-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setRunOutcome(null);
            setRunScore(null);
            try {
              if (!selectedTemplateId) throw new Error('Select a template');
              if (!hasRules) throw new Error('Selected template has no rules. Add rules first.');

              if (inputSource === 'UPLOAD') {
                if (!file) throw new Error('Select a file');
              }

              if (inputSource === 'INTEGRATION') {
                if (!selectedIntegrationId) throw new Error('Select an integration');
                if (integrationsError) {
                  throw new Error(
                    `Integrations are unavailable for your account (${integrationsError}). Ask a Manager/Admin to create integrations or grant access.`
                  );
                }
              }

              const newRunId = crypto.randomUUID();
              setRunId(newRunId);
              setRunStatus('QUEUED');

              let uploadPayload:
                | {
                    storagePath: string;
                    fileName: string;
                    contentType?: string;
                  }
                | undefined;

              let integrationPayload:
                | {
                    integrationId: string;
                    query?: Record<string, unknown>;
                  }
                | undefined;

              if (inputSource === 'UPLOAD') {
                const storagePath = `tenants/${claims.tenantId}/uploads/${newRunId}/${file!.name}`;
                const storage = getFirebaseStorage();
                const r = storageRef(storage, storagePath);
                await uploadBytes(r, file!, file!.type ? { contentType: file!.type } : undefined);

                uploadPayload = {
                  storagePath,
                  fileName: file!.name,
                  ...(file!.type ? { contentType: file!.type } : {})
                };
              }

              if (inputSource === 'INTEGRATION') {
                let query: Record<string, unknown> | undefined;
                const trimmed = integrationQueryText.trim();
                if (trimmed) {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(trimmed);
                  } catch {
                    throw new Error('Integration query must be valid JSON (an object like {"id":"123"}).');
                  }
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Integration query must be a JSON object (e.g. {"id":"123"}).');
                  }
                  query = parsed as Record<string, unknown>;
                }

                integrationPayload = {
                  integrationId: selectedIntegrationId,
                  ...(query ? { query } : {})
                };
              }

              const client = await createAuthedClient(user);
              await client.request<CreateRunResponse>('/v1/qc-runs', {
                method: 'POST',
                body: JSON.stringify({
                  runId: newRunId,
                  mode: 'SYNC',
                  templateId: selectedTemplateId,
                  inputSource,
                  ...(inputSource === 'UPLOAD' ? { upload: uploadPayload } : {}),
                  ...(inputSource === 'INTEGRATION' ? { integration: integrationPayload } : {})
                })
              });

              if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
              pollTimerRef.current = window.setInterval(() => {
                void pollOnce(newRunId).catch(() => {
                  // keep polling; transient errors are possible
                });
              }, 1500);

              // Immediately fetch once.
              await pollOnce(newRunId);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="text-sm text-zinc-700">Input source</div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="radio"
                  name="inputSource"
                  checked={inputSource === 'UPLOAD'}
                  onChange={() => setInputSource('UPLOAD')}
                />
                Upload
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="radio"
                  name="inputSource"
                  checked={inputSource === 'INTEGRATION'}
                  onChange={() => setInputSource('INTEGRATION')}
                />
                Integration
              </label>
            </div>

            {inputSource === 'INTEGRATION' ? (
              <div className="text-xs text-zinc-500">
                Uses a saved integration to fetch data from an external tool.
              </div>
            ) : null}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-700">Template</span>
            <select
              className="rounded border px-3 py-2"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              required
            >
              <option value="" disabled>
                Select…
              </option>
              {templates.map((t) => {
                const id = t.templateId ?? t.id;
                const rulesCount = Array.isArray(t.rules) ? t.rules.length : 0;
                return (
                  <option key={t.id} value={id}>
                    {t.name ?? id} ({rulesCount} rules)
                  </option>
                );
              })}
            </select>
          </label>

          {selectedTemplateId && !hasRules ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              This template has no rules. <a href={`/templates/${encodeURIComponent(selectedTemplateId)}`} className="underline">Add rules first</a>.
            </div>
          ) : null}

          {inputSource === 'UPLOAD' ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-zinc-700">Upload file</span>
              <input
                className="rounded border px-3 py-2"
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
            </label>
          ) : null}

          {inputSource === 'INTEGRATION' ? (
            <div className="flex flex-col gap-3 rounded border bg-zinc-50 p-3">
              {integrationsError ? (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Cannot load integrations: {integrationsError}
                </div>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-700">Integration</span>
                <select
                  className="rounded border px-3 py-2"
                  value={selectedIntegrationId}
                  onChange={(e) => setSelectedIntegrationId(e.target.value)}
                  required
                  disabled={Boolean(integrationsError)}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {integrations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.type ?? 'Integration'} ({i.id})
                    </option>
                  ))}
                </select>
                <div className="text-xs text-zinc-500">
                  Manage integrations on the Integrations page.
                </div>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-700">Query (optional)</span>
                <textarea
                  className="min-h-20 rounded border px-3 py-2 font-mono text-xs"
                  value={integrationQueryText}
                  onChange={(e) => setIntegrationQueryText(e.target.value)}
                  placeholder='{"id":"123"}'
                />
                <div className="text-xs text-zinc-500">
                  JSON object. Keys become URL query parameters for the integration request.
                </div>
              </label>

              <button
                className="w-fit rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60"
                type="button"
                onClick={() => void loadIntegrations()}
                disabled={busy}
              >
                Refresh integrations
              </button>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={
                busy ||
                !hasRules ||
                (inputSource === 'UPLOAD' ? !file : false) ||
                (inputSource === 'INTEGRATION' ? !selectedIntegrationId || Boolean(integrationsError) : false)
              }
              type="submit"
            >
              {busy ? 'Working…' : 'Start run'}
            </button>
            <button
              className="rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-60"
              type="button"
              disabled={!pollTimerRef.current}
              onClick={() => {
                if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
              }}
            >
              Stop polling
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-lg border bg-white p-4">
        <h2 className="text-lg font-semibold text-zinc-950">Status</h2>
        <div className="mt-2 text-sm text-zinc-700">Run ID: <span className="font-mono text-xs">{runId || '—'}</span></div>
        <div className="mt-1 text-sm text-zinc-700">Status: <span className="font-medium">{runStatus ?? '—'}</span></div>

        <div className="mt-1 text-sm text-zinc-700">Outcome: <span className="font-medium">{runOutcome ?? '—'}</span></div>
        <div className="mt-1 text-sm text-zinc-700">Score: <span className="font-medium">{runScore ?? '—'}</span></div>

        {runId ? (
          <div className="mt-4">
            <a className="text-sm font-medium text-zinc-950 hover:underline" href={`/runs/${encodeURIComponent(runId)}`}>
              View explainable results
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
