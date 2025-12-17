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
  currentVersion?: number;
};

type TemplatesListResponse = {
  templates: Template[];
};

type TemplateVersion = {
  id: string;
  templateId?: string;
  version?: number;
  createdAt?: unknown;
};

type TemplateVersionsResponse = {
  versions: TemplateVersion[];
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
    templateVersionId: string;
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
  const [versions, setVersions] = useState<TemplateVersion[]>([]);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runId, setRunId] = useState<string>('');
  const [runStatus, setRunStatus] = useState<RunGetResponse['run']['status'] | null>(null);
  const [runOutcome, setRunOutcome] = useState<string | null>(null);
  const [runScore, setRunScore] = useState<number | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  const canRun = useMemo(() => Boolean(user && claims.tenantId), [user, claims.tenantId]);

  async function loadTemplates() {
    if (!user) return;
    const client = await createAuthedClient(user);
    const resp = await client.request<TemplatesListResponse>('/v1/templates');
    setTemplates(resp.templates ?? []);
  }

  async function loadVersions(templateId: string) {
    if (!user) return;
    const client = await createAuthedClient(user);
    const resp = await client.request<TemplateVersionsResponse>(`/v1/templates/${encodeURIComponent(templateId)}/versions`);
    setVersions(resp.versions ?? []);
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
    }

    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [loading, canRun]);

  useEffect(() => {
    setVersions([]);
    setSelectedVersionId('');
    if (!selectedTemplateId) return;
    void loadVersions(selectedTemplateId).catch((e) => setError(e instanceof Error ? e.message : 'Unknown error'));
  }, [selectedTemplateId]);

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
        <h1 className="text-2xl font-semibold text-zinc-950">Run QC (Upload + polling)</h1>
        <p className="mt-1 text-sm text-zinc-600">Uploads a file to Storage and starts an ASYNC run, then polls status.</p>
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
              if (!selectedVersionId) throw new Error('Select a template version');
              if (!file) throw new Error('Select a file');

              const newRunId = crypto.randomUUID();
              setRunId(newRunId);
              setRunStatus('QUEUED');

              const storagePath = `tenants/${claims.tenantId}/uploads/${newRunId}/${file.name}`;
              const storage = getFirebaseStorage();
              const r = storageRef(storage, storagePath);
              await uploadBytes(r, file, file.type ? { contentType: file.type } : undefined);

              const client = await createAuthedClient(user);
              await client.request<CreateRunResponse>('/v1/qc-runs', {
                method: 'POST',
                body: JSON.stringify({
                  runId: newRunId,
                  mode: 'ASYNC',
                  templateId: selectedTemplateId,
                  templateVersionId: selectedVersionId,
                  inputSource: 'UPLOAD',
                  upload: {
                    storagePath,
                    fileName: file.name,
                    ...(file.type ? { contentType: file.type } : {})
                  }
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
                return (
                  <option key={t.id} value={id}>
                    {t.name ?? id}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-700">Template version</span>
            <select
              className="rounded border px-3 py-2"
              value={selectedVersionId}
              onChange={(e) => setSelectedVersionId(e.target.value)}
              required
              disabled={!selectedTemplateId}
            >
              <option value="" disabled>
                {selectedTemplateId ? 'Select…' : 'Select a template first'}
              </option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version ?? '?'} ({v.id})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-700">Upload file</span>
            <input
              className="rounded border px-3 py-2"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={busy}
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
