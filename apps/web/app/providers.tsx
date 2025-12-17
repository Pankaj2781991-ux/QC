'use client';

import { AuthProvider } from '../lib/auth';

export function Providers(props: { children: React.ReactNode }) {
  return <AuthProvider>{props.children}</AuthProvider>;
}
