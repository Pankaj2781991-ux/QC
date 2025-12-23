'use client';

import { useState } from 'react';

import { useAuth } from '../../../lib/auth';
import { createAuthedClient } from '../../../lib/api';

type BootstrapResponse = {
  ok: true;
  tenantId: string;
};

export default function DashboardPage() {
  const { user, claims, loading } = useAuth();

  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <div>Loading…</div>;
  if (!user) return null;

  const needsBootstrap = !claims.tenantId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-600">Signed in as {user.email ?? user.uid}</p>
      </div>

      <div className="rounded-lg border bg-white p-4">
        <div className="grid gap-2 text-sm">
          <div>
            <span className="text-zinc-500">Tenant</span>: <span className="font-medium">{claims.tenantId ?? '—'}</span>
          </div>
          <div>
            <span className="text-zinc-500">Role</span>: <span className="font-medium">{claims.role ?? '—'}</span>
          </div>
        </div>
      </div>

      {needsBootstrap ? (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-950">Bootstrap tenant</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Your account has no tenant claim yet. Create the first tenant (and become Admin).
          </p>

          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const client = await createAuthedClient(user);
                const resp = await client.request<BootstrapResponse>('/v1/tenants/bootstrap', {
                  method: 'POST',
                  body: JSON.stringify({ tenantName })
                });

                // Force refresh so custom claims show up in the client.
                await user.getIdToken(true);

                // The AuthProvider listens for token changes; a hard refresh is the most reliable.
                window.location.replace('/templates');

                // Use resp to avoid unused variable linting if enabled.
                void resp;
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-sm text-zinc-700">Tenant name</span>
              <input
                className="rounded border px-3 py-2"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                placeholder="Acme Corp"
                required
              />
            </label>

            {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

            <button
              className="mt-1 w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Working…' : 'Create tenant'}
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="text-lg font-semibold text-zinc-950">Quick links</h2>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <a className="rounded border px-3 py-2 text-zinc-900 hover:bg-zinc-50" href="/templates">
              Templates
            </a>
            <a className="rounded border px-3 py-2 text-zinc-900 hover:bg-zinc-50" href="/runs/new">
              Run QC
            </a>
            <a className="rounded border px-3 py-2 text-zinc-900 hover:bg-zinc-50" href="/integrations">
              Integrations
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
