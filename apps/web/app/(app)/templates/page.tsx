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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  type Severity = 'BLOCKER' | 'MAJOR' | 'MINOR' | 'INFO';
  type RuleType = 'TEXT_REQUIRED_PHRASE' | 'TEXT_REGEX' | 'TEXT_KEYWORD_BLACKLIST' | 'REQUIRED_FIELD';

  type RuleBuilder =
    | {
        uiId: string;
        type: 'TEXT_REQUIRED_PHRASE';
        name: string;
        severity: Severity;
        applyTo: 'WHOLE_DOCUMENT' | 'FIELD';
        fieldPathText: string;
        phrase: string;
        caseSensitive: boolean;
        enabled: boolean;
      }
    | {
        uiId: string;
        type: 'TEXT_REGEX';
        name: string;
        severity: Severity;
        applyTo: 'WHOLE_DOCUMENT' | 'FIELD';
        fieldPathText: string;
        pattern: string;
        flags: string;
        mustMatch: boolean;
        enabled: boolean;
      }
    | {
        uiId: string;
        type: 'TEXT_KEYWORD_BLACKLIST';
        name: string;
        severity: Severity;
        applyTo: 'WHOLE_DOCUMENT' | 'FIELD';
        fieldPathText: string;
        keywordsText: string;
        caseSensitive: boolean;
        enabled: boolean;
      }
    | {
        uiId: string;
        type: 'REQUIRED_FIELD';
        name: string;
        severity: Severity;
        fieldPathText: string;
        allowEmptyString: boolean;
        enabled: boolean;
      };

  const [rules, setRules] = useState<RuleBuilder[]>([]);
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

  function beginEdit(t: Template) {
    setEditingId(t.templateId ?? t.id);
    setEditName(t.name ?? '');
    setEditDescription(t.description ?? '');
  }

  function makeUiId() {
    // crypto.randomUUID is supported by modern browsers; fall back for safety.
    try {
      return crypto.randomUUID();
    } catch {
      return `r_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    }
  }

  function makeDefaultRules(): RuleBuilder[] {
    return [
      {
        uiId: makeUiId(),
        type: 'TEXT_REQUIRED_PHRASE',
        name: 'Must include Order ID',
        severity: 'MAJOR',
        applyTo: 'WHOLE_DOCUMENT',
        fieldPathText: '',
        phrase: 'Order ID',
        caseSensitive: false,
        enabled: true
      },
      {
        uiId: makeUiId(),
        type: 'TEXT_KEYWORD_BLACKLIST',
        name: 'Must not include banned words',
        severity: 'MINOR',
        applyTo: 'WHOLE_DOCUMENT',
        fieldPathText: '',
        keywordsText: 'scam, refund',
        caseSensitive: false,
        enabled: true
      }
    ];
  }

  function parseFieldPath(text: string): string[] | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const parts = trimmed
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }

  function toRuleSnapshot(builderRules: RuleBuilder[]): unknown[] {
    return builderRules.map((r, idx) => {
      const base = {
        ruleId: r.uiId,
        version: 1,
        type: r.type,
        enabled: r.enabled,
        severity: r.severity,
        weight: 1,
        name: r.name.trim(),
        tags: [] as string[]
      };

      if (r.type === 'REQUIRED_FIELD') {
        const fp = parseFieldPath(r.fieldPathText);
        return {
          ...base,
          params: {
            fieldPath: fp ?? [],
            allowEmptyString: r.allowEmptyString
          }
        };
      }

      const fieldPath = r.applyTo === 'FIELD' ? parseFieldPath(r.fieldPathText) : undefined;
      if (r.type === 'TEXT_REQUIRED_PHRASE') {
        return {
          ...base,
          params: {
            ...(fieldPath ? { fieldPath } : {}),
            phrase: r.phrase,
            caseSensitive: r.caseSensitive
          }
        };
      }

      if (r.type === 'TEXT_REGEX') {
        return {
          ...base,
          params: {
            ...(fieldPath ? { fieldPath } : {}),
            pattern: r.pattern,
            flags: r.flags?.trim() ? r.flags.trim() : undefined,
            mustMatch: r.mustMatch
          }
        };
      }

      const keywords = r.keywordsText
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

      return {
        ...base,
        params: {
          ...(fieldPath ? { fieldPath } : {}),
          keywords,
          caseSensitive: r.caseSensitive
        }
      };
    });
  }

  useEffect(() => {
    // When a template is selected, help non-technical users by pre-seeding rules
    // if the template has no versions yet.
    if (!selectedTemplateId) return;
    if (!canCreate) return;
    if (versionsBusy) return;
    if (versions.length > 0) return;
    setRules((prev) => (prev.length ? prev : makeDefaultRules()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, versionsBusy, versions.length, canCreate]);

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
                  <th className="py-2 pr-4 font-medium">Actions</th>
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
                    <td className="py-2 pr-4 text-sm text-zinc-700">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded border bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-60"
                          onClick={() => beginEdit(t)}
                          disabled={!canCreate}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded border bg-white px-2 py-1 text-xs hover:bg-red-50 disabled:opacity-60"
                          onClick={async () => {
                            if (!canCreate) return;
                            const confirm = window.confirm('Delete this template and its versions?');
                            if (!confirm) return;
                            try {
                              setBusy(true);
                              setError(null);
                              const client = await createAuthedClient(user);
                              await client.request(`/v1/templates/${encodeURIComponent(t.templateId ?? t.id)}`, {
                                method: 'DELETE'
                              });
                              if (selectedTemplateId === (t.templateId ?? t.id)) {
                                setSelectedTemplateId('');
                                setVersions([]);
                              }
                              if (editingId === (t.templateId ?? t.id)) {
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
                          disabled={!canCreate}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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

      {canCreate ? (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-950">Create template</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Create a template first, then add a few simple rules (no coding required).
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
                const resp = await client.request<TemplateCreateResponse>('/v1/templates', {
                  method: 'POST',
                  body: JSON.stringify({
                    name: name.trim(),
                    ...(description.trim() ? { description: description.trim() } : {})
                  })
                });
                setName('');
                setDescription('');
                await refresh();
                setSelectedTemplateId(resp.templateId);
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
        <div className="rounded-lg border bg-white p-4 text-sm text-zinc-600">Requires Manager or Admin to create templates.</div>
      )}

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
                <p className="mt-1 text-xs text-zinc-500">Add a few rules below. We convert this to the engine format automatically.</p>

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
                      if (!rules.length) throw new Error('Add at least one rule to create a version.');

                      const snapshot = toRuleSnapshot(rules);
                      // Client-side validation to give fast feedback; server re-validates too.
                      snapshot.forEach((r) => void QcRuleDefinitionSchema.parse(r));

                      const client = await createAuthedClient(user);
                      const resp = await client.request<TemplateVersionCreateResponse>(
                        `/v1/templates/${encodeURIComponent(selectedTemplateId)}/versions`,
                        {
                          method: 'POST',
                          body: JSON.stringify({ ruleSnapshot: snapshot })
                        }
                      );

                      setVersionMessage(`Created version v${resp.version} (${resp.templateVersionId}).`);
                      setRules([]);
                      await refreshVersions(selectedTemplateId);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Unknown error');
                    } finally {
                      setCreatingVersion(false);
                    }
                  }}
                >
                  <div className="flex flex-col gap-3">
                    {rules.length ? null : (
                      <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                        Start with a couple of common rules, then edit them to match your needs.
                        <div className="mt-2">
                          <button
                            type="button"
                            className="rounded bg-zinc-900 px-3 py-1 text-sm font-medium text-white"
                            onClick={() => setRules(makeDefaultRules())}
                          >
                            Add starter rules
                          </button>
                        </div>
                      </div>
                    )}

                    {rules.map((r, i) => (
                      <div key={r.uiId} className="rounded border p-3">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                          <label className="flex min-w-[180px] flex-col gap-1">
                            <span className="text-xs text-zinc-600">Rule type</span>
                            <select
                              className="rounded border px-2 py-2 text-sm"
                              value={r.type}
                              onChange={(e) => {
                                const nextType = e.target.value as RuleType;
                                setRules((prev) =>
                                  prev.map((rr) => {
                                    if (rr.uiId !== r.uiId) return rr;
                                    if (nextType === rr.type) return rr;

                                    if (nextType === 'TEXT_REQUIRED_PHRASE') {
                                      return {
                                        uiId: rr.uiId,
                                        type: 'TEXT_REQUIRED_PHRASE',
                                        name: 'Must include phrase',
                                        severity: 'MAJOR',
                                        applyTo: 'WHOLE_DOCUMENT',
                                        fieldPathText: '',
                                        phrase: 'Order ID',
                                        caseSensitive: false,
                                        enabled: true
                                      };
                                    }
                                    if (nextType === 'TEXT_REGEX') {
                                      return {
                                        uiId: rr.uiId,
                                        type: 'TEXT_REGEX',
                                        name: 'Must match pattern',
                                        severity: 'MAJOR',
                                        applyTo: 'WHOLE_DOCUMENT',
                                        fieldPathText: '',
                                        pattern: '\\bORDER\\-\\d+\\b',
                                        flags: 'i',
                                        mustMatch: true,
                                        enabled: true
                                      };
                                    }
                                    if (nextType === 'TEXT_KEYWORD_BLACKLIST') {
                                      return {
                                        uiId: rr.uiId,
                                        type: 'TEXT_KEYWORD_BLACKLIST',
                                        name: 'Must not include words',
                                        severity: 'MINOR',
                                        applyTo: 'WHOLE_DOCUMENT',
                                        fieldPathText: '',
                                        keywordsText: 'scam, refund',
                                        caseSensitive: false,
                                        enabled: true
                                      };
                                    }
                                    return {
                                      uiId: rr.uiId,
                                      type: 'REQUIRED_FIELD',
                                      name: 'Required field',
                                      severity: 'MAJOR',
                                      fieldPathText: 'orderId',
                                      allowEmptyString: false,
                                      enabled: true
                                    };
                                  })
                                );
                              }}
                            >
                              <option value="TEXT_REQUIRED_PHRASE">Must include phrase</option>
                              <option value="TEXT_KEYWORD_BLACKLIST">Must not include words</option>
                              <option value="TEXT_REGEX">Must match pattern</option>
                              <option value="REQUIRED_FIELD">Required field (JSON input)</option>
                            </select>
                          </label>

                          <label className="flex flex-1 min-w-[220px] flex-col gap-1">
                            <span className="text-xs text-zinc-600">Rule name</span>
                            <input
                              className="rounded border px-2 py-2 text-sm"
                              value={r.name}
                              onChange={(e) => setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, name: e.target.value } : rr)))}
                              required
                            />
                          </label>

                          <label className="flex min-w-[150px] flex-col gap-1">
                            <span className="text-xs text-zinc-600">Severity</span>
                            <select
                              className="rounded border px-2 py-2 text-sm"
                              value={r.severity}
                              onChange={(e) =>
                                setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, severity: e.target.value as Severity } : rr)))
                              }
                            >
                              <option value="BLOCKER">Blocker</option>
                              <option value="MAJOR">Major</option>
                              <option value="MINOR">Minor</option>
                              <option value="INFO">Info</option>
                            </select>
                          </label>

                          <label className="flex items-center gap-2 text-sm text-zinc-700">
                            <input
                              type="checkbox"
                              checked={r.enabled}
                              onChange={(e) => setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, enabled: e.target.checked } : rr)))}
                            />
                            Enabled
                          </label>

                          <button
                            type="button"
                            className="rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                            onClick={() => setRules((prev) => prev.filter((rr) => rr.uiId !== r.uiId))}
                            aria-label={`Remove rule ${i + 1}`}
                          >
                            Remove
                          </button>
                        </div>

                        <div className="mt-3 grid gap-3">
                          {r.type !== 'REQUIRED_FIELD' ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="flex min-w-[220px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Apply to</span>
                                <select
                                  className="rounded border px-2 py-2 text-sm"
                                  value={r.applyTo}
                                  onChange={(e) =>
                                    setRules((prev) =>
                                      prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, applyTo: e.target.value as any } : rr))
                                    )
                                  }
                                >
                                  <option value="WHOLE_DOCUMENT">Whole document</option>
                                  <option value="FIELD">Specific field</option>
                                </select>
                              </label>

                              {r.applyTo === 'FIELD' ? (
                                <label className="flex flex-1 min-w-[220px] flex-col gap-1">
                                  <span className="text-xs text-zinc-600">Field (dot path)</span>
                                  <input
                                    className="rounded border px-2 py-2 text-sm"
                                    value={r.fieldPathText}
                                    onChange={(e) =>
                                      setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, fieldPathText: e.target.value } : rr)))
                                    }
                                    placeholder="customer.email"
                                  />
                                </label>
                              ) : null}
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="flex flex-1 min-w-[220px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Required field (dot path)</span>
                                <input
                                  className="rounded border px-2 py-2 text-sm"
                                  value={r.fieldPathText}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, fieldPathText: e.target.value } : rr)))
                                  }
                                  placeholder="orderId"
                                  required
                                />
                              </label>
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={r.allowEmptyString}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, allowEmptyString: e.target.checked } : rr)))
                                  }
                                />
                                Allow empty string
                              </label>
                            </div>
                          )}

                          {r.type === 'TEXT_REQUIRED_PHRASE' ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="flex flex-1 min-w-[240px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Required phrase</span>
                                <input
                                  className="rounded border px-2 py-2 text-sm"
                                  value={r.phrase}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, phrase: e.target.value } : rr)))
                                  }
                                  placeholder="Order ID"
                                  required
                                />
                              </label>
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={r.caseSensitive}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, caseSensitive: e.target.checked } : rr)))
                                  }
                                />
                                Case sensitive
                              </label>
                            </div>
                          ) : null}

                          {r.type === 'TEXT_KEYWORD_BLACKLIST' ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="flex flex-1 min-w-[240px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Banned words (comma separated)</span>
                                <input
                                  className="rounded border px-2 py-2 text-sm"
                                  value={r.keywordsText}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, keywordsText: e.target.value } : rr)))
                                  }
                                  placeholder="refund, scam"
                                  required
                                />
                              </label>
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={r.caseSensitive}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, caseSensitive: e.target.checked } : rr)))
                                  }
                                />
                                Case sensitive
                              </label>
                            </div>
                          ) : null}

                          {r.type === 'TEXT_REGEX' ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <label className="flex flex-1 min-w-[260px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Pattern</span>
                                <input
                                  className="rounded border px-2 py-2 font-mono text-xs"
                                  value={r.pattern}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, pattern: e.target.value } : rr)))
                                  }
                                  placeholder="\\bORDER\\-\\d+\\b"
                                  required
                                />
                              </label>
                              <label className="flex min-w-[120px] flex-col gap-1">
                                <span className="text-xs text-zinc-600">Flags</span>
                                <input
                                  className="rounded border px-2 py-2 font-mono text-xs"
                                  value={r.flags}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, flags: e.target.value } : rr)))
                                  }
                                  placeholder="i"
                                />
                              </label>
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={r.mustMatch}
                                  onChange={(e) =>
                                    setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, mustMatch: e.target.checked } : rr)))
                                  }
                                />
                                Must match
                              </label>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                        onClick={() =>
                          setRules((prev) => [
                            ...prev,
                            {
                              uiId: makeUiId(),
                              type: 'TEXT_REQUIRED_PHRASE',
                              name: 'Must include phrase',
                              severity: 'MAJOR',
                              applyTo: 'WHOLE_DOCUMENT',
                              fieldPathText: '',
                              phrase: 'Order ID',
                              caseSensitive: false,
                              enabled: true
                            }
                          ])
                        }
                      >
                        Add rule
                      </button>

                      {rules.length ? (
                        <button
                          type="button"
                          className="rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                          onClick={() => setRules(makeDefaultRules())}
                        >
                          Reset to starter rules
                        </button>
                      ) : null}
                    </div>
                  </div>

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
    </div>
  );
}
