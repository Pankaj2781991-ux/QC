'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../../lib/auth';
import { createAuthedClient } from '../../../lib/api';
import { roleAtLeast } from '../../../lib/rbac';

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

type IntegrationCreateResponse = {
  integrationId: string;
};

export default function IntegrationsPage() {
  const { user, claims, loading } = useAuth();

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = useMemo(() => roleAtLeast(claims.role, 'Manager'), [claims.role]);

  // Generic connector config fields
  const [baseUrl, setBaseUrl] = useState('');
  const [path, setPath] = useState('');
  const [apiKeyHeader, setApiKeyHeader] = useState('Authorization');
  const [apiKeyPrefix, setApiKeyPrefix] = useState('Bearer ');
  const [apiKey, setApiKey] = useState('');

  async function refresh() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const client = await createAuthedClient(user);
      const resp = await client.request<IntegrationsListResponse>('/v1/integrations');
      setIntegrations(resp.integrations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!loading && user && claims.tenantId && canManage) void refresh();
  }, [loading, user, claims.tenantId, canManage]);

  if (loading) return <div>Loading…</div>;
  if (!user) return null;

  if (!claims.tenantId) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h1 className="text-2xl font-semibold text-zinc-950">Integrations</h1>
        <p className="mt-2 text-sm text-zinc-600">You must bootstrap/join a tenant first.</p>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h1 className="text-2xl font-semibold text-zinc-950">Integrations</h1>
        <p className="mt-2 text-sm text-zinc-600">Requires Manager or Admin to view/manage integrations.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950">Integrations</h1>
          <p className="mt-1 text-sm text-zinc-600">List and create external data integrations.</p>
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
          {busy ? 'Loading integrations…' : integrations.length ? `${integrations.length} integration(s)` : 'No integrations yet.'}
        </div>

        {integrations.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Auth</th>
                  <th className="py-2 pr-4 font-medium">Integration ID</th>
                </tr>
              </thead>
              <tbody>
                {integrations.map((i) => (
                  <tr key={i.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-zinc-950">{i.type ?? '—'}</div>
                      {i.type === 'GENERIC_API_KEY_JSON_V1' ? (
                        <div className="mt-1 text-xs text-zinc-500">
                          baseUrl: {String(i.config?.baseUrl ?? '')} path: {String(i.config?.path ?? '')}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-zinc-700">{i.authType ?? '—'}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{i.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border bg-white p-4">
        <h2 className="text-lg font-semibold text-zinc-950">Create integration</h2>
        <p className="mt-1 text-sm text-zinc-600">Creates a GENERIC_API_KEY_JSON_V1 integration (API key stored in Secret Manager).</p>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setCreating(true);
            setError(null);
            try {
              const client = await createAuthedClient(user);
              await client.request<IntegrationCreateResponse>('/v1/integrations', {
                method: 'POST',
                body: JSON.stringify({
                  type: 'GENERIC_API_KEY_JSON_V1',
                  authType: 'API_KEY',
                  config: {
                    baseUrl: baseUrl.trim(),
                    path: path.trim(),
                    ...(apiKeyHeader.trim() ? { apiKeyHeader: apiKeyHeader.trim() } : {}),
                    ...(apiKeyPrefix !== undefined ? { apiKeyPrefix } : {})
                  },
                  apiKey: apiKey
                })
              });

              setBaseUrl('');
              setPath('');
              setApiKeyHeader('Authorization');
              setApiKeyPrefix('Bearer ');
              setApiKey('');
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
              setCreating(false);
            }
          }}
        >
          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-700">Base URL</span>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[11px] font-semibold text-zinc-600"
                aria-label="Explain Base URL"
                title={
                  'Base URL is the main address of the system you are connecting to. You usually copy this from that system\'s API documentation. Example: https://api.company.com (do not include the /v1/... part here). We need it so QC knows where to send requests to fetch your data.'
                }
              >
                i
              </button>
            </div>
            <input
              className="rounded border px-3 py-2"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
              required
            />
          </label>

          <label className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-700">Path</span>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[11px] font-semibold text-zinc-600"
                aria-label="Explain Path"
                title={
                  'Path is the specific API route that returns the data you want. It starts with /. Example: /v1/tickets or /api/calls. We combine Base URL + Path to fetch your data automatically when you run QC from an integration.'
                }
              >
                i
              </button>
            </div>
            <input
              className="rounded border px-3 py-2"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/v1/resource"
              required
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-700">API key header</span>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[11px] font-semibold text-zinc-600"
                  aria-label="Explain API key header"
                  title={
                    'This is the name of the “box” (header) where the other system expects the API key. Common values are Authorization or X-API-Key. If you are unsure, check the other system\'s API docs.'
                  }
                >
                  i
                </button>
              </div>
              <input className="rounded border px-3 py-2" value={apiKeyHeader} onChange={(e) => setApiKeyHeader(e.target.value)} />
            </label>

            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-700">API key prefix</span>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 bg-white text-[11px] font-semibold text-zinc-600"
                  aria-label="Explain API key prefix"
                  title={
                    'Some systems want extra text before the key. Example: “Bearer ” (note the space) so the final value becomes “Bearer YOUR_KEY”. If the docs show the key by itself, leave this blank.'
                  }
                >
                  i
                </button>
              </div>
              <input className="rounded border px-3 py-2" value={apiKeyPrefix} onChange={(e) => setApiKeyPrefix(e.target.value)} />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-700">API key</span>
            <input
              className="rounded border px-3 py-2"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="…"
              required
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
    </div>
  );
}
