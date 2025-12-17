'use client';

import { onIdTokenChanged, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getFirebaseAuth } from './firebase';

export type AuthClaims = {
  tenantId?: string;
  role?: 'Admin' | 'Manager' | 'Viewer';
};

type AuthState = {
  user: User | null;
  claims: AuthClaims;
  loading: boolean;
};

const AuthCtx = createContext<AuthState>({ user: null, claims: {}, loading: true });

export function AuthProvider(props: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<AuthClaims>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getFirebaseAuth();
    return onIdTokenChanged(auth, async (u) => {
      setUser(u);
      if (!u) {
        setClaims({});
        setLoading(false);
        return;
      }
      const tokenResult = await u.getIdTokenResult();
      const tenantId = (tokenResult.claims as any).tenantId as string | undefined;
      const role = (tokenResult.claims as any).role as AuthClaims['role'] | undefined;
      setClaims({ tenantId, role });
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthState>(() => ({ user, claims, loading }), [user, claims, loading]);
  return <AuthCtx.Provider value={value}>{props.children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
