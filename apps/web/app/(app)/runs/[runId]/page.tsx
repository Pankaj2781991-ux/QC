'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

import { useAuth } from '../../../../lib/auth';
import { createAuthedClient } from '../../../../lib/api';

type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

type RuleStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'ERROR';

type EvidenceRef = {
  kind: 'TEXT_SNIPPET' | 'FIELD_VALUE' | 'FILE_REF' | 'SHEET_CELL' | 'TIME_RANGE' | 'GENERIC' | (string & {});
  title: string;
  detail?: string;
  source?: { storagePath?: string; fileName?: string; contentType?: string };
  location?: {
    fieldPath?: Array<string | number>;
    line?: number;
    column?: number;
    sheet?: string;
    row?: number;
    cell?: string;
    startMs?: number;
    endMs?: number;
  };
  snippet?: { text: string; start?: number; end?: number };
};

type QcPublicError = {
  category: 'VALIDATION' | 'INTEGRATION' | 'EXECUTION' | 'RULE_EVALUATION';
  code: string;
  message: string;
  help?: string;
  retryable: boolean;
};

type FirestoreTimestampJson = {
  _seconds: number;
  _nanoseconds?: number;
};

type TimestampLike = FirestoreTimestampJson | { toDate: () => Date } | string | null | undefined;

type InputRef =
  | { inline: unknown }
  | { upload: { storagePath: string; fileName?: string; contentType?: string } }
  | {
      integration: {
        integrationId: string;
        type?: string;
        authType?: 'API_KEY' | 'OAUTH';
        query?: Record<string, unknown>;
      };
    };

type RunDoc = {
  id: string;
  runId: string;
  tenantId?: string;
  status: RunStatus;
  mode: 'SYNC' | 'ASYNC';
  templateId: string;
  templateName?: string;
  templateVersion: number;
  templateVersionId: string;
  engineVersion: string;
  inputSource: 'INLINE' | 'UPLOAD' | 'INTEGRATION';
  inputRef?: InputRef;
  requestedAt?: TimestampLike;
  startedAt?: TimestampLike;
  completedAt?: TimestampLike;
  error?: QcPublicError;
  resultId?: string;
};

type ResultSummaryDoc = {
  id: string;
  resultId?: string;
  createdAt?: TimestampLike;
  executedAt?: TimestampLike;
  engineVersion?: string;
  writeState?: 'WRITING' | 'COMPLETE';
  expectedRuleCount?: number;
  chat?: { enabled: boolean; strategy: string; chatCount: number; warning?: string };
  summary?: {
    overallOutcome?: 'PASS' | 'FAIL';
    overallScore?: number;
    failedRuleIds?: string[];
    ruleCounts?: { total: number; pass: number; fail: number; notEvaluated: number; error: number };
  };
  integrity?: {
    templateVersionId?: string;
    templateVersion?: number;
    inputFingerprint?: { type: 'SHA256'; value: string };
  };
};

type ChatResultSummary = {
  id: string;
  chatResultId?: string;
  index: number;
  title: string;
  chatId?: string;
  participants?: { operator?: string; customer?: string };
  summary?: {
    overallOutcome?: 'PASS' | 'FAIL';
    overallScore?: number;
    failedRuleIds?: string[];
    ruleCounts?: { total: number; pass: number; fail: number; notEvaluated: number; error: number };
  };
};

type RuleResult = {
  id: string;
  ruleResultId?: string;
  order: number;
  ruleId: string;
  ruleName: string;
  ruleType: string;
  weight: number;
  severity: string;
  status: RuleStatus;
  score: number;
  reason?: string;
  evidence: EvidenceRef[];
  error?: QcPublicError;
};

type RunGetResponse = {
  run: RunDoc;
  resultSummary: ResultSummaryDoc | null;
};

type RuleResultsResponse = {
  ruleResults: RuleResult[];
  nextStartAfter: number | null;
};

type ChatResultsResponse = {
  chatResults: ChatResultSummary[];
  nextStartAfter: number | null;
};

function tsLabel(ts: TimestampLike): string {
  if (!ts) return '—';
  // Admin SDK sends Timestamp objects; API currently returns raw data. Best-effort display.
  const d =
    typeof ts === 'object' && ts && '_seconds' in ts
      ? new Date((ts as FirestoreTimestampJson)._seconds * 1000)
      : typeof ts === 'object' && ts && 'toDate' in ts
        ? (ts as any).toDate()
        : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString();
}

export default function RunResultsPage() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId;

  const { user, claims, loading } = useAuth();

  const [run, setRun] = useState<RunDoc | null>(null);
  const [resultSummary, setResultSummary] = useState<ResultSummaryDoc | null>(null);
  const [ruleResults, setRuleResults] = useState<RuleResult[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  const [chatResults, setChatResults] = useState<ChatResultSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string>('__ALL__');

  const [chatRuleResults, setChatRuleResults] = useState<RuleResult[]>([]);
  const [chatNextStartAfter, setChatNextStartAfter] = useState<number | null>(-1);

  const [busy, setBusy] = useState(false);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [lastUpdatedAtIso, setLastUpdatedAtIso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [nextStartAfter, setNextStartAfter] = useState<number | null>(-1);

  const refreshInFlightRef = useRef(false);
  const consecutiveAutoFailuresRef = useRef(0);

  const activeRuleResults = useMemo(
    () => (selectedChatId === '__ALL__' ? ruleResults : chatRuleResults),
    [selectedChatId, ruleResults, chatRuleResults]
  );

  const selected = useMemo(
    () => activeRuleResults.find((r) => r.id === selectedRuleId) ?? null,
    [activeRuleResults, selectedRuleId]
  );

  async function refresh(options?: { silent?: boolean }) {
    if (!user || !runId) return;

    // Prevent overlapping refreshes (manual clicks + interval).
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    const silent = options?.silent === true;
    if (silent) setAutoRefreshing(true);
    else {
      setBusy(true);
      setError(null);
    }

    try {
      const client = await createAuthedClient(user);
      const resp = await client.request<RunGetResponse>(`/v1/qc-runs/${encodeURIComponent(runId)}`);
      setRun(resp.run);
      setResultSummary(resp.resultSummary);

      const chatEnabled = Boolean(resp.resultSummary?.chat?.enabled);
      if (resp.run.status === 'SUCCEEDED' && chatEnabled && chatResults.length === 0) {
        const cr = await client.request<ChatResultsResponse>(
          `/v1/qc-runs/${encodeURIComponent(runId)}/chat-results?limit=200&startAfter=-1`
        );
        setChatResults(cr.chatResults ?? []);
      }

      setLastUpdatedAtIso(new Date().toISOString());
      consecutiveAutoFailuresRef.current = 0;

      if (resp.run.status === 'SUCCEEDED') {
        // Load first page of rule results (avoid reloading on every auto tick).
        const shouldLoadFirstPage = ruleResults.length === 0;
        if (shouldLoadFirstPage) {
          const rr = await client.request<RuleResultsResponse>(
            `/v1/qc-runs/${encodeURIComponent(runId)}/rule-results?limit=100&startAfter=-1`
          );
          const next = rr.ruleResults ?? [];
          setRuleResults(next);
          setNextStartAfter(rr.nextStartAfter);
          if (!selectedRuleId && next.length) setSelectedRuleId(next[0]!.id);
        }
      }
    } catch (e) {
      if (silent) {
        consecutiveAutoFailuresRef.current += 1;
        // Non-chatty behavior: only surface after repeated failures and pause.
        if (consecutiveAutoFailuresRef.current >= 5) {
          setError('Auto-refresh paused due to repeated errors. Use Refresh to retry.');
          setAutoRefreshEnabled(false);
        }
      } else {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
    } finally {
      refreshInFlightRef.current = false;
      if (silent) setAutoRefreshing(false);
      else setBusy(false);
    }
  }

  async function loadMore() {
    if (!user || !runId) return;
    if (selectedChatId === '__ALL__' && nextStartAfter === null) return;
    if (selectedChatId !== '__ALL__' && chatNextStartAfter === null) return;
    setBusy(true);
    setError(null);
    try {
      const client = await createAuthedClient(user);
      if (selectedChatId === '__ALL__') {
        const rr = await client.request<RuleResultsResponse>(
          `/v1/qc-runs/${encodeURIComponent(runId)}/rule-results?limit=100&startAfter=${encodeURIComponent(String(nextStartAfter))}`
        );
        setRuleResults((prev) => [...prev, ...(rr.ruleResults ?? [])]);
        setNextStartAfter(rr.nextStartAfter);
      } else {
        if (chatNextStartAfter === null) return;
        const rr = await client.request<RuleResultsResponse>(
          `/v1/qc-runs/${encodeURIComponent(runId)}/chat-results/${encodeURIComponent(selectedChatId)}/rule-results?limit=100&startAfter=${encodeURIComponent(String(chatNextStartAfter))}`
        );
        setChatRuleResults((prev) => [...prev, ...(rr.ruleResults ?? [])]);
        setChatNextStartAfter(rr.nextStartAfter);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // When switching chats, load first page of that chat's rule results.
    if (!user || !runId) return;
    if (selectedChatId === '__ALL__') {
      setChatRuleResults([]);
      setChatNextStartAfter(-1);
      return;
    }

    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const client = await createAuthedClient(user);
        const rr = await client.request<RuleResultsResponse>(
          `/v1/qc-runs/${encodeURIComponent(runId)}/chat-results/${encodeURIComponent(selectedChatId)}/rule-results?limit=100&startAfter=-1`
        );
        if (cancelled) return;
        setChatRuleResults(rr.ruleResults ?? []);
        setChatNextStartAfter(rr.nextStartAfter);
        const first = (rr.ruleResults ?? [])[0]?.id ?? null;
        setSelectedRuleId(first);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, runId, selectedChatId]);

  useEffect(() => {
    if (!loading && user && claims.tenantId && runId) void refresh();
  }, [loading, user, claims.tenantId, runId]);

  useEffect(() => {
    if (!user || !claims.tenantId || !runId) return;
    if (!autoRefreshEnabled) return;

    const status = run?.status;
    const shouldPoll = status === 'QUEUED' || status === 'RUNNING' || !status;
    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [user, claims.tenantId, runId, run?.status, autoRefreshEnabled]);

  if (loading) return <div>Loading…</div>;
  if (!user) return null;
  if (!claims.tenantId) return <div className="rounded-lg border bg-white p-4">You must bootstrap/join a tenant first.</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950">Run results</h1>
          <div className="mt-1 text-sm text-zinc-600">Run ID: <span className="font-mono text-xs">{runId}</span></div>
          <div className="mt-1 text-xs text-zinc-500">
            Last updated: <span className="font-medium">{lastUpdatedAtIso ?? '—'}</span>
            {autoRefreshing ? <span className="ml-2">(auto-refreshing…)</span> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            className="rounded border bg-white px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>

          <label className="flex items-center gap-2 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(e) => {
                consecutiveAutoFailuresRef.current = 0;
                setError(null);
                setAutoRefreshEnabled(e.target.checked);
              }}
            />
            Auto-refresh
          </label>
        </div>
      </div>

      {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <div className="rounded-lg border bg-white p-4">
        <h2 className="text-lg font-semibold text-zinc-950">Run summary</h2>
        <div className="mt-3 grid gap-2 text-sm text-zinc-700 md:grid-cols-2">
          <div>
            <span className="text-zinc-500">Template</span>: <span className="font-medium">{run?.templateName ?? run?.templateId ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Version</span>: <span className="font-medium">v{run?.templateVersion ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Status</span>: <span className="font-medium">{run?.status ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Data source</span>: <span className="font-medium">{run?.inputSource ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Requested</span>: <span className="font-medium">{tsLabel(run?.requestedAt)}</span>
          </div>
          <div>
            <span className="text-zinc-500">Started</span>: <span className="font-medium">{tsLabel(run?.startedAt)}</span>
          </div>
          <div>
            <span className="text-zinc-500">Completed</span>: <span className="font-medium">{tsLabel(run?.completedAt)}</span>
          </div>
          <div>
            <span className="text-zinc-500">Score</span>:{' '}
            <span className="font-medium">{resultSummary?.summary?.overallScore ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Outcome</span>:{' '}
            <span className="font-medium">{resultSummary?.summary?.overallOutcome ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Executed</span>:{' '}
            <span className="font-medium">{tsLabel(resultSummary?.executedAt)}</span>
          </div>
        </div>

        {run?.status === 'FAILED' && run.error ? (
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <div className="font-medium">{run.error.message}</div>
            {run.error.help ? <div className="mt-1 text-xs">{run.error.help}</div> : null}
            <div className="mt-2 text-xs text-red-700">Code: {run.error.code}</div>
          </div>
        ) : null}

        {resultSummary?.chat?.warning ? (
          <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-medium">Chat splitting note</div>
            <div className="mt-1 text-xs">{resultSummary.chat.warning}</div>
          </div>
        ) : null}
      </div>

      {run?.status === 'SUCCEEDED' ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-lg border bg-white p-4">
            <h2 className="text-lg font-semibold text-zinc-950">Rule results</h2>

            {resultSummary?.chat?.enabled ? (
              <div className="mt-3 rounded border bg-zinc-50 p-3 text-sm text-zinc-700">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-500">Chat breakdown</div>
                    <div className="font-medium">{resultSummary.chat.chatCount} chats detected</div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-600">Chat</span>
                    <select
                      className="rounded border bg-white px-2 py-1"
                      value={selectedChatId}
                      onChange={(e) => {
                        setSelectedChatId(e.target.value);
                        setSelectedRuleId(null);
                      }}
                    >
                      <option value="__ALL__">All chats (combined)</option>
                      {chatResults
                        .slice()
                        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            Chat {Number(c.index ?? 0) + 1}: {c.title}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {resultSummary.chat.warning ? (
                  <div className="mt-2 text-xs text-amber-900">
                    Note: {resultSummary.chat.warning}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Rule</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Weight</th>
                    <th className="py-2 pr-4 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRuleResults.map((r) => (
                    <tr
                      key={r.id}
                      className={`border-b last:border-b-0 ${selectedRuleId === r.id ? 'bg-zinc-50' : ''}`}
                      onClick={() => setSelectedRuleId(r.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="py-2 pr-4">
                        <div className="font-medium text-zinc-950">{r.ruleName}</div>
                        <div className="font-mono text-xs text-zinc-500">{r.ruleId}</div>
                      </td>
                      <td className="py-2 pr-4 text-zinc-700">{r.ruleType}</td>
                      <td className="py-2 pr-4 text-zinc-700">{r.status}</td>
                      <td className="py-2 pr-4 text-zinc-700">{r.weight}</td>
                      <td className="py-2 pr-4 text-zinc-600">{r.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(selectedChatId === '__ALL__' ? nextStartAfter : chatNextStartAfter) !== null ? (
              <div className="mt-4">
                <button
                  className="rounded border bg-white px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void loadMore()}
                >
                  {busy ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : (
              <div className="mt-4 text-xs text-zinc-500">All rule results loaded.</div>
            )}
          </div>

          <div className="rounded-lg border bg-white p-4">
            <h2 className="text-lg font-semibold text-zinc-950">Evidence</h2>
            {selected ? (
              <div className="mt-3 flex flex-col gap-3">
                <div className="text-sm text-zinc-700">
                  <div className="font-medium text-zinc-950">{selected.ruleName}</div>
                  <div className="text-xs text-zinc-500">{selected.ruleType} • {selected.status}</div>
                </div>

                {selected.error ? (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <div className="font-medium">{selected.error.message}</div>
                    {selected.error.help ? <div className="mt-1 text-xs">{selected.error.help}</div> : null}
                  </div>
                ) : null}

                {(selected.evidence ?? []).length ? (
                  <div className="flex flex-col gap-2">
                    {selected.evidence.map((e, idx) => (
                      <div key={idx} className="rounded border bg-white p-3">
                        <div className="text-sm font-medium text-zinc-950">{e.title}</div>
                        {e.detail ? <div className="mt-1 text-sm text-zinc-700">{e.detail}</div> : null}
                        {e.snippet?.text ? (
                          <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-800">{e.snippet.text}</pre>
                        ) : null}
                        {e.source?.storagePath ? (
                          <div className="mt-2 text-xs text-zinc-500">File: {e.source.fileName ?? '—'} ({e.source.storagePath})</div>
                        ) : null}
                        {e.location?.fieldPath?.length ? (
                          <div className="mt-1 text-xs text-zinc-500">Field: {e.location.fieldPath.join('.')}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-zinc-600">No evidence recorded.</div>
                )}
              </div>
            ) : (
              <div className="mt-3 text-sm text-zinc-600">Select a rule to view evidence.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-white p-4 text-sm text-zinc-600">
          Rule results are available once the run reaches SUCCEEDED.
        </div>
      )}
    </div>
  );
}
