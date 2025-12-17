import type { User } from 'firebase/auth';

export type ApiClient = {
  baseUrl: string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
};

export function getApiBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true' && projectId) {
    return `http://localhost:5001/${projectId}/us-central1/api`;
  }

  throw new Error('Missing NEXT_PUBLIC_FUNCTIONS_BASE_URL');
}

export async function createAuthedClient(user: User | null): Promise<ApiClient> {
  const baseUrl = getApiBaseUrl();

  return {
    baseUrl,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      if (user) {
        const token = await user.getIdToken();
        headers.set('Authorization', `Bearer ${token}`);
      }

      const resp = await fetch(url, { ...init, headers });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const message = json?.error?.message ?? `HTTP ${resp.status}`;
        const code = json?.error?.code ?? 'UNKNOWN';
        throw new Error(`${code}: ${message}`);
      }
      return json as T;
    }
  };
}
