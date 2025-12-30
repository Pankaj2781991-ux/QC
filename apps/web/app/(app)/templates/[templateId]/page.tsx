'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { useAuth } from '../../../../lib/auth';
import { createAuthedClient } from '../../../../lib/api';
import { roleAtLeast } from '../../../../lib/rbac';
import { QcRuleDefinitionSchema } from '@qc/qc-engine';

type Template = {
    id: string;
    templateId?: string;
    name?: string;
    description?: string | null;
    rules?: unknown[];
};

type TemplateResponse = {
    template: Template;
};

type TemplateVersion = {
    id: string;
    version?: number;
    ruleSnapshot?: unknown[];
};

type TemplateVersionsListResponse = {
    versions: TemplateVersion[];
};

type TemplateVersionCreateResponse = {
    templateVersionId: string;
    version: number;
};

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

function makeUiId() {
    try {
        return crypto.randomUUID();
    } catch {
        return `r_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    }
}

function parseFieldPath(text: string): string[] | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const parts = trimmed.split('.').map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
}

function toRuleSnapshot(builderRules: RuleBuilder[]): unknown[] {
    return builderRules.map((r) => {
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

        const keywords = r.keywordsText.split(',').map((k) => k.trim()).filter(Boolean);

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

function fromRuleSnapshot(snapshot: unknown[]): RuleBuilder[] {
    return snapshot.map((r: any) => {
        const uiId = r.ruleId || makeUiId();
        const base = {
            uiId,
            name: r.name ?? '',
            severity: r.severity ?? 'MAJOR',
            enabled: r.enabled ?? true
        };

        if (r.type === 'TEXT_REQUIRED_PHRASE') {
            return {
                ...base,
                type: 'TEXT_REQUIRED_PHRASE' as const,
                applyTo: r.params?.fieldPath?.length ? ('FIELD' as const) : ('WHOLE_DOCUMENT' as const),
                fieldPathText: r.params?.fieldPath?.join('.') ?? '',
                phrase: r.params?.phrase ?? '',
                caseSensitive: r.params?.caseSensitive ?? false
            };
        }

        if (r.type === 'TEXT_REGEX') {
            return {
                ...base,
                type: 'TEXT_REGEX' as const,
                applyTo: r.params?.fieldPath?.length ? ('FIELD' as const) : ('WHOLE_DOCUMENT' as const),
                fieldPathText: r.params?.fieldPath?.join('.') ?? '',
                pattern: r.params?.pattern ?? '',
                flags: r.params?.flags ?? '',
                mustMatch: r.params?.mustMatch ?? true
            };
        }

        if (r.type === 'TEXT_KEYWORD_BLACKLIST') {
            return {
                ...base,
                type: 'TEXT_KEYWORD_BLACKLIST' as const,
                applyTo: r.params?.fieldPath?.length ? ('FIELD' as const) : ('WHOLE_DOCUMENT' as const),
                fieldPathText: r.params?.fieldPath?.join('.') ?? '',
                keywordsText: (r.params?.keywords ?? []).join(', '),
                caseSensitive: r.params?.caseSensitive ?? false
            };
        }

        if (r.type === 'REQUIRED_FIELD') {
            return {
                ...base,
                type: 'REQUIRED_FIELD' as const,
                fieldPathText: r.params?.fieldPath?.join('.') ?? '',
                allowEmptyString: r.params?.allowEmptyString ?? false
            };
        }

        // Default fallback
        return {
            ...base,
            type: 'TEXT_REQUIRED_PHRASE' as const,
            applyTo: 'WHOLE_DOCUMENT' as const,
            fieldPathText: '',
            phrase: '',
            caseSensitive: false
        };
    });
}

export default function TemplateRulesPage() {
    const params = useParams();
    const templateId = params.templateId as string;

    const { user, claims, loading } = useAuth();

    const [template, setTemplate] = useState<Template | null>(null);
    const [rules, setRules] = useState<RuleBuilder[]>([]);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    const canEdit = useMemo(() => roleAtLeast(claims.role, 'Manager'), [claims.role]);

    async function loadTemplate() {
        if (!user || !templateId) return;
        setBusy(true);
        setError(null);
        try {
            const client = await createAuthedClient(user);
            const resp = await client.request<TemplateResponse>(`/v1/templates/${encodeURIComponent(templateId)}`);
            setTemplate(resp.template);

            // Prefer the latest version's snapshot (versioned templates).
            // Fall back to template.rules for older tenants/data.
            try {
                const versionsResp = await client.request<TemplateVersionsListResponse>(
                    `/v1/templates/${encodeURIComponent(templateId)}/versions`
                );
                const latest = (versionsResp.versions ?? [])[0];
                const snapshot = Array.isArray(latest?.ruleSnapshot) ? latest!.ruleSnapshot! : (resp.template.rules ?? []);
                setRules(fromRuleSnapshot(Array.isArray(snapshot) ? snapshot : []));
            } catch {
                setRules(fromRuleSnapshot(resp.template.rules ?? []));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setBusy(false);
        }
    }

    async function saveRules() {
        if (!user || !templateId) return;
        setSaving(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const snapshot = toRuleSnapshot(rules);
            if (snapshot.length === 0) throw new Error('Add at least one rule before saving.');
            // Validate rules client-side
            snapshot.forEach((r) => void QcRuleDefinitionSchema.parse(r));

            const client = await createAuthedClient(user);
            const resp = await client.request<TemplateVersionCreateResponse>(
                `/v1/templates/${encodeURIComponent(templateId)}/versions`,
                {
                    method: 'POST',
                    body: JSON.stringify({ ruleSnapshot: snapshot })
                }
            );

            setSuccessMessage(`Saved ${rules.length} rule(s) as version v${resp.version}.`);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSaving(false);
        }
    }

    useEffect(() => {
        if (!loading && user && claims.tenantId && templateId) {
            void loadTemplate();
        }
    }, [loading, user, claims.tenantId, templateId]);

    if (loading) return <div>Loading…</div>;
    if (!user) return null;

    if (!claims.tenantId) {
        return (
            <div className="rounded-lg border bg-white p-4">
                <h1 className="text-2xl font-semibold text-zinc-950">Template Rules</h1>
                <p className="mt-2 text-sm text-zinc-600">You must bootstrap/join a tenant first.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <Link href="/templates" className="text-sm text-zinc-500 hover:underline">
                        ← Back to Templates
                    </Link>
                    <h1 className="mt-2 text-2xl font-semibold text-zinc-950">
                        {template?.name ?? 'Template Rules'}
                    </h1>
                    {template?.description ? (
                        <p className="mt-1 text-sm text-zinc-600">{template.description}</p>
                    ) : null}
                </div>
                <button
                    className="rounded border bg-white px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
                    onClick={() => void loadTemplate()}
                    disabled={busy}
                >
                    {busy ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
            {successMessage ? <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{successMessage}</div> : null}

            <div className="rounded-lg border bg-white p-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-zinc-950">Rules ({rules.length})</h2>
                    {canEdit && (
                        <button
                            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                            disabled={saving}
                            onClick={() => void saveRules()}
                        >
                            {saving ? 'Saving…' : 'Save Rules'}
                        </button>
                    )}
                </div>

                <div className="mt-4 flex flex-col gap-3">
                    {rules.length === 0 ? (
                        <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                            No rules yet. Add your first rule below.
                        </div>
                    ) : null}

                    {rules.map((r, i) => (
                        <div key={r.uiId} className="rounded border p-3">
                            <div className="flex flex-wrap items-end justify-between gap-3">
                                <label className="flex min-w-[180px] flex-col gap-1">
                                    <span className="text-xs text-zinc-600">Rule type</span>
                                    <select
                                        className="rounded border px-2 py-2 text-sm"
                                        value={r.type}
                                        disabled={!canEdit}
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
                                                            phrase: '',
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
                                                            pattern: '',
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
                                                            keywordsText: '',
                                                            caseSensitive: false,
                                                            enabled: true
                                                        };
                                                    }
                                                    return {
                                                        uiId: rr.uiId,
                                                        type: 'REQUIRED_FIELD',
                                                        name: 'Required field',
                                                        severity: 'MAJOR',
                                                        fieldPathText: '',
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
                                        disabled={!canEdit}
                                        onChange={(e) => setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, name: e.target.value } : rr)))}
                                        required
                                    />
                                </label>

                                <label className="flex min-w-[150px] flex-col gap-1">
                                    <span className="text-xs text-zinc-600">Severity</span>
                                    <select
                                        className="rounded border px-2 py-2 text-sm"
                                        value={r.severity}
                                        disabled={!canEdit}
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
                                        disabled={!canEdit}
                                        onChange={(e) => setRules((prev) => prev.map((rr) => (rr.uiId === r.uiId ? { ...rr, enabled: e.target.checked } : rr)))}
                                    />
                                    Enabled
                                </label>

                                {canEdit && (
                                    <button
                                        type="button"
                                        className="rounded border bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                                        onClick={() => setRules((prev) => prev.filter((rr) => rr.uiId !== r.uiId))}
                                        aria-label={`Remove rule ${i + 1}`}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>

                            <div className="mt-3 grid gap-3">
                                {r.type !== 'REQUIRED_FIELD' ? (
                                    <div className="flex flex-wrap items-end gap-3">
                                        <label className="flex min-w-[220px] flex-col gap-1">
                                            <span className="text-xs text-zinc-600">Apply to</span>
                                            <select
                                                className="rounded border px-2 py-2 text-sm"
                                                value={r.applyTo}
                                                disabled={!canEdit}
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
                                                    disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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
                                                disabled={!canEdit}
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

                    {canEdit && (
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
                                            phrase: '',
                                            caseSensitive: false,
                                            enabled: true
                                        }
                                    ])
                                }
                            >
                                + Add Rule
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
