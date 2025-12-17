'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { useAuth } from '../lib/auth';
import { getFirebaseAuth } from '../lib/firebase';

export function AppNav() {
  const { claims } = useAuth();
  const router = useRouter();

  return (
    <div className="border-b bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="font-semibold">
            QC Platform
          </Link>
          <Link href="/templates" className="text-sm text-zinc-700 hover:text-zinc-950">
            Templates
          </Link>
          <Link href="/runs/new" className="text-sm text-zinc-700 hover:text-zinc-950">
            Run QC
          </Link>
          <Link href="/integrations" className="text-sm text-zinc-700 hover:text-zinc-950">
            Integrations
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-700">
          <span>{claims.role ?? '—'}</span>
          <button
            className="rounded border px-3 py-1 hover:bg-zinc-50"
            onClick={async () => {
              await signOut(getFirebaseAuth());
              router.replace('/');
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
