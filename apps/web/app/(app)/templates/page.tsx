'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '../../../lib/auth';
import { createAuthedClient } from '../../../lib/api';
import { roleAtLeast } from '../../../lib/rbac';

type Template = {
  id: string;
  templateId?: string;
  name?: string;
  description?: string | null;
  rules?: unknown[];
  updatedAt?: unknown;
};

type TemplatesListResponse = {
  templates: Template[];
};

type TemplateCreateResponse = {
  templateId: string;
};

export default function TemplatesPage() {
  const { user, claims, loading } = useAuth();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const canManageTemplates = useMemo(() => roleAtLeast(claims.role, 'Admin'), [claims.role]);

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

  useEffect(() => {
    if (!loading && user && claims.tenantId) void refresh();
  }, [loading, user, claims.tenantId]);

  function beginEdit(t: Template) {
    setEditingId(t.id);
    setEditName(t.name ?? '');
    setEditDescription(t.description ?? '');
  }

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
          <p className="mt-1 text-sm text-zinc-600">Create and manage QC templates. Click a template name to manage its rules.</p>
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
                  <th className="py-2 pr-4 font-medium">Rules</th>
                  <th className="py-2 pr-4 font-medium">Template ID</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const id = t.id;
                  const displayId = t.templateId ?? t.id;
                  const rulesCount = Array.isArray(t.rules) ? t.rules.length : 0;
                  return (
                    <tr key={t.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-4">
                        <Link
                          href={`/templates/${encodeURIComponent(id)}`}
                          className="font-medium text-zinc-950 hover:underline"
                        >
                          {t.name ?? '—'}
                        </Link>
                        {t.description ? <div className="text-xs text-zinc-500">{t.description}</div> : null}
                      </td>
                      <td className="py-2 pr-4 text-zinc-700">
                        {rulesCount} rule{rulesCount !== 1 ? 's' : ''}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{displayId}</td>
                      <td className="py-2 pr-4 text-sm text-zinc-700">
                        <div className="flex flex-wrap gap-2">
                          <Link
                            href={`/templates/${encodeURIComponent(id)}`}
                            className="rounded border bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                          >
                            Manage Rules
                          </Link>
                          <button
                            type="button"
                            className="rounded border bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-60"
                            onClick={() => beginEdit(t)}
                            disabled={!canManageTemplates}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded border bg-white px-2 py-1 text-xs hover:bg-red-50 disabled:opacity-60"
                            onClick={async () => {
                              if (!canManageTemplates) return;
                              const confirm = window.confirm('Delete this template and its rules?');
                              if (!confirm) return;
                              try {
                                setBusy(true);
                                setError(null);
                                const client = await createAuthedClient(user);
                                await client.request(`/v1/templates/${encodeURIComponent(id)}`, {
                                  method: 'DELETE'
                                });
                                if (editingId === id) {
                                  setEditingId(null);
                                  setEditName('');
                                  setEditDescription('');
                                }
                                await refresh();
                              } catch (err) {
                                setError(err instanceof Error ? err.message : 'Unknown error');
                              } finally {
                                setBusy(false);
                              }
                            }}
                            disabled={!canManageTemplates}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {editingId ? (
              <div className="mt-4 rounded border bg-zinc-50 p-3">
                <h3 className="text-sm font-semibold text-zinc-950">Edit template</h3>
                <form
                  className="mt-3 flex flex-col gap-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!user) return;
                    setBusy(true);
                    setError(null);
                    try {
                      const client = await createAuthedClient(user);
                      await client.request(`/v1/templates/${encodeURIComponent(editingId)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                          ...(editName.trim() ? { name: editName.trim() } : {}),
                          description: editDescription.trim() ? editDescription.trim() : null
                        })
                      });
                      await refresh();
                      setEditingId(null);
                      setEditName('');
                      setEditDescription('');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Unknown error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-zinc-700">Name</span>
                    <input
                      className="rounded border px-3 py-2"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-zinc-700">Description (optional)</span>
                    <textarea
                      className="min-h-20 rounded border px-3 py-2"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                    />
                  </label>

                  <div className="flex gap-2">
                    <button
                      className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                      disabled={busy}
                      type="submit"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className="rounded border bg-white px-4 py-2 text-sm hover:bg-zinc-50"
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setEditName('');
                        setEditDescription('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {canManageTemplates ? (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-950">Create template</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Create a template, then click on it to add rules.
          </p>
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
                  body: JSON.stringify({
                    name: name.trim(),
                    ...(description.trim() ? { description: description.trim() } : {})
                  })
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
              <span className="text-sm text-zinc-700">Template name</span>
              <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm text-zinc-700">Description (optional)</span>
              <textarea className="min-h-24 rounded border px-3 py-2" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>

            <button
              className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={creating}
              type="submit"
            >
              {creating ? 'Creating…' : 'Create template'}
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded-lg border bg-white p-4 text-sm text-zinc-600">Requires Admin to create templates.</div>
      )}
    </div>
  );
}
