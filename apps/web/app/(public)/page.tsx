'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';

import { getFirebaseAuth } from '../../lib/firebase';
import { createAuthedClient } from '../../lib/api';

type Mode = 'login' | 'signup';

export default function LandingPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const router = useRouter();

  const title = useMemo(() => (mode === 'login' ? 'Log in' : 'Create your tenant'), [mode]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-16">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">Quality Check Platform</h1>
          <p className="mt-2 text-zinc-600">
            Multi-tenant, auditable QC runs with deterministic rules and optional AI-assisted signals (never final authority).
          </p>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          <div className="rounded-lg border bg-white p-6">
            <div className="flex gap-2">
              <button
                className={`rounded px-3 py-1 text-sm ${mode === 'login' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700'}`}
                onClick={() => {
                  setError(null);
                  setMode('login');
                }}
              >
                Log in
              </button>
              <button
                className={`rounded px-3 py-1 text-sm ${mode === 'signup' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700'}`}
                onClick={() => {
                  setError(null);
                  setMode('signup');
                }}
              >
                Sign up
              </button>
            </div>

            <h2 className="mt-4 text-lg font-semibold text-zinc-950">{title}</h2>

            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  const auth = getFirebaseAuth();

                  if (mode === 'login') {
                    await signInWithEmailAndPassword(auth, email, password);
                    router.push('/dashboard');
                    return;
                  }

                  if (!tenantName.trim()) {
                    setError('Tenant name is required');
                    return;
                  }

                  const cred = await createUserWithEmailAndPassword(auth, email, password);
                  const client = await createAuthedClient(cred.user);
                  await client.request('/v1/tenants/bootstrap', {
                    method: 'POST',
                    body: JSON.stringify({ tenantName })
                  });

                  // Refresh token so custom claims appear.
                  await cred.user.getIdToken(true);
                  router.push('/dashboard');
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Unknown error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {mode === 'signup' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-zinc-700">Tenant name</span>
                  <input
                    className="rounded border px-3 py-2"
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    placeholder="Acme Corp"
                  />
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-700">Email</span>
                <input
                  className="rounded border px-3 py-2"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  required
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-700">Password</span>
                <input
                  className="rounded border px-3 py-2"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                />
              </label>

              {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

              <button
                className="mt-2 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy}
                type="submit"
              >
                {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create tenant'}
              </button>

              {mode === 'login' ? (
                <p className="text-xs text-zinc-500">
                  If your account isn’t provisioned for a tenant yet, log in and use the dashboard bootstrap.
                </p>
              ) : null}
            </form>
          </div>

          <div className="rounded-lg border bg-white p-6">
            <h2 className="text-lg font-semibold text-zinc-950">What you can do</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-700">
              <li>Create QC parameter templates and version them</li>
              <li>Run QC on uploads or external API integrations</li>
              <li>Get deterministic pass/fail, scores, evidence, and audit trails</li>
              <li>Use optional AI signals with explicit threshold logic</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
