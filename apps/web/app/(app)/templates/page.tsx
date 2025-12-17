'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../../lib/auth';
import { createAuthedClient } from '../../../lib/api';
import { roleAtLeast } from '../../../lib/rbac';
import { QcRuleDefinitionSchema } from '@qc/qc-engine';

type Template = {
  id: string;
  templateId?: string;
  name?: string;
  description?: string | null;
  currentVersion?: number;
  updatedAt?: unknown;
};

type TemplatesListResponse = {
  templates: Template[];
};

type TemplateCreateResponse = {
  templateId: string;
};

type TemplateVersion = {
  id: string;
  templateId?: string;
  version?: number;
  engineVersion?: string;
  createdAt?: unknown;
  createdByUid?: string;
};

type TemplateVersionsListResponse = {
  versions: TemplateVersion[];
};

type TemplateVersionCreateResponse = {
  templateVersionId: string;
  version: number;
};

export default function TemplatesPage() {
  const { user, claims, loading } = useAuth();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [versionsBusy, setVersionsBusy] = useState(false);

  const [ruleSnapshotJson, setRuleSnapshotJson] = useState('');
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [versionMessage, setVersionMessage] = useState<string | null>(null);

  const canCreate = useMemo(() => roleAtLeast(claims.role, 'Manager'), [claims.role]);

  async function refresh() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const client = await createAuthedClient(user);
      const resp = await client.request<TemplatesListResponse>('/v1/templates');
      setTemplates(resp.templates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshVersions(templateId: string) {
    if (!user) return;
    setVersionsBusy(true);
    setVersionMessage(null);
    setError(null);
    try {
      const client = await createAuthedClient(user);
      const resp = await client.request<TemplateVersionsListResponse>(
        `/v1/templates/${encodeURIComponent(templateId)}/versions`
      );
      setVersions(resp.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setVersionsBusy(false);
    }
  }

  useEffect(() => {
    if (!loading && user && claims.tenantId) void refresh();
  }, [loading, user, claims.tenantId]);

  useEffect(() => {
    setVersions([]);
    if (!selectedTemplateId) return;
    void refreshVersions(selectedTemplateId);
  }, [selectedTemplateId]);

  if (loading) return <div>Loading…</div>;
  if (!user) return null;

  if (!claims.tenantId) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h1 className="text-2xl font-semibold text-zinc-950">Templates</h1>
        <p className="mt-2 text-sm text-zinc-600">You must bootstrap/join a tenant first.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950">Templates</h1>
          <p className="mt-1 text-sm text-zinc-600">List and create QC templates for your tenant.</p>
        </div>
        <button
          className="rounded border bg-white px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <div className="rounded-lg border bg-white p-4">
        <div className="text-sm text-zinc-700">
          {busy ? 'Loading templates…' : templates.length ? `${templates.length} template(s)` : 'No templates yet.'}
        </div>

        {templates.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Current version</th>
                  <th className="py-2 pr-4 font-medium">Template ID</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        className="text-left font-medium text-zinc-950 hover:underline"
                        onClick={() => {
                          const id = t.templateId ?? t.id;
                          setSelectedTemplateId(id);
                          setVersionMessage(null);
                        }}
                      >
                        {t.name ?? '—'}
                      </button>
                      {t.description ? <div className="text-xs text-zinc-500">{t.description}</div> : null}
                    </td>
                    <td className="py-2 pr-4 text-zinc-700">{t.currentVersion ?? 0}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{t.templateId ?? t.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-950">Template versions</h2>
            <p className="mt-1 text-sm text-zinc-600">Click a template name above to view/create versions.</p>
          </div>
          <button
            className="rounded border bg-white px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
            type="button"
            disabled={!selectedTemplateId || versionsBusy}
            onClick={() => {
              if (!selectedTemplateId) return;
              void refreshVersions(selectedTemplateId);
            }}
          >
            {versionsBusy ? 'Refreshing…' : 'Refresh versions'}
          </button>
        </div>

        <div className="mt-3 text-sm text-zinc-700">
          Selected template: <span className="font-mono text-xs">{selectedTemplateId || '—'}</span>
        </div>

        {versionMessage ? (
          <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            {versionMessage}
          </div>
        ) : null}

        {selectedTemplateId ? (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Version</th>
                    <th className="py-2 pr-4 font-medium">Engine</th>
                    <th className="py-2 pr-4 font-medium">Version ID</th>
                  </tr>
                </thead>
                <tbody>
                  {(versions ?? []).map((v) => (
                    <tr key={v.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-4 text-zinc-700">v{v.version ?? '—'}</td>
                      <td className="py-2 pr-4 text-zinc-700">{v.engineVersion ?? '—'}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{v.id}</td>
                    </tr>
                  ))}
                  {!versionsBusy && versions.length === 0 ? (
                    <tr>
                      <td className="py-2 text-sm text-zinc-600" colSpan={3}>
                        No versions yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {canCreate ? (
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-zinc-950">Create new version</h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Paste a JSON array of rule definitions as `ruleSnapshot`.
                </p>

                <form
                  className="mt-3 flex flex-col gap-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!user) return;
                    if (!selectedTemplateId) return;
                    setCreatingVersion(true);
                    setError(null);
                    setVersionMessage(null);
                    try {
                      const parsed = JSON.parse(ruleSnapshotJson);
                      if (!Array.isArray(parsed)) throw new Error('ruleSnapshot must be a JSON array');
                      // Client-side validation to give fast feedback; server re-validates too.
                      parsed.forEach((r) => void QcRuleDefinitionSchema.parse(r));

                      const client = await createAuthedClient(user);
                      const resp = await client.request<TemplateVersionCreateResponse>(
                        `/v1/templates/${encodeURIComponent(selectedTemplateId)}/versions`,
                        {
                          method: 'POST',
                          body: JSON.stringify({ ruleSnapshot: parsed })
                        }
                      );

                      setVersionMessage(`Created version v${resp.version} (${resp.templateVersionId}).`);
                      setRuleSnapshotJson('');
                      await refreshVersions(selectedTemplateId);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Unknown error');
                    } finally {
                      setCreatingVersion(false);
                    }
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-zinc-700">ruleSnapshot (JSON)</span>
                    <textarea
                      className="min-h-48 rounded border px-3 py-2 font-mono text-xs"
                      value={ruleSnapshotJson}
                      onChange={(e) => setRuleSnapshotJson(e.target.value)}
                      placeholder='[\n  {\n    "type": "TEXT_REGEX",\n    "ruleId": "example",\n    "title": "Must include Order ID",\n    "weight": 1,\n    "pattern": "\\\\bORDER\\\\-\\\\d+\\\\b",\n    "flags": "i"\n  }\n]'
                      required
                    />
                  </label>

                  <button
                    className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                    disabled={creatingVersion}
                    type="submit"
                  >
                    {creatingVersion ? 'Creating…' : 'Create version'}
                  </button>
                </form>
              </div>
            ) : (
              <div className="mt-4 text-sm text-zinc-600">Requires Manager or Admin to create template versions.</div>
            )}
          </>
        ) : (
          <div className="mt-4 text-sm text-zinc-600">Select a template to view versions.</div>
        )}
      </div>

      {canCreate ? (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-950">Create template</h2>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setCreating(true);
              setError(null);
              try {
                const client = await createAuthedClient(user);
                await client.request<TemplateCreateResponse>('/v1/templates', {
                  method: 'POST',
                  body: JSON.stringify({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) })
                });
                setName('');
                setDescription('');
                await refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
              } finally {
                setCreating(false);
              }
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-sm text-zinc-700">Name</span>
              <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm text-zinc-700">Description (optional)</span>
              <textarea
                className="min-h-24 rounded border px-3 py-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>

            <button
              className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={creating}
              type="submit"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded-lg border bg-white p-4 text-sm text-zinc-600">Requires Manager or Admin to create templates.</div>
      )}
    </div>
  );
}
