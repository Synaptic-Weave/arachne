export const ADMIN_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface AdminTenant {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export interface AdminApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

export interface AdminProviderConfig {
  provider: 'openai' | 'azure' | 'ollama';
  baseUrl?: string;
  hasApiKey: boolean;
  deployment?: string;
  apiVersion?: string;
}

export function getAdminToken(): string | null {
  return localStorage.getItem('loom_admin_token');
}

export function setAdminToken(token: string): void {
  localStorage.setItem('loom_admin_token', token);
}

export function clearAdminToken(): void {
  localStorage.removeItem('loom_admin_token');
}

export function adminAuthHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  
  if (!token && !path.endsWith('/login')) {
    clearAdminToken();
    window.location.href = '/dashboard/admin';
    throw new Error('Admin token missing');
  }

  const url = `${ADMIN_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...adminAuthHeaders(),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearAdminToken();
    window.location.href = '/dashboard/admin';
    throw new Error('Admin session expired');
  }

  return response;
}
