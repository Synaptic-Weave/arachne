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

export interface AdminSettings {
  signupsEnabled: boolean;
  defaultEmbedderProvider: string | null;
  defaultEmbedderModel: string | null;
  defaultEmbedderApiKey: string | null;
  defaultEmbedderProviderId: string | null;
  updatedAt: string;
  updatedByAdminId: string | null;
}

export interface AdminBetaSignup {
  id: string;
  email: string;
  name: string | null;
  inviteCode: string | null;
  approvedAt: string | null;
  approvedByAdminId: string | null;
  inviteUsedAt: string | null;
  createdAt: string;
  status: 'pending' | 'approved' | 'used';
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
  const headers: Record<string, string> = {
    ...adminAuthHeaders(),
    ...(options.headers as Record<string, string> || {}),
  };

  // Only set Content-Type if there's a body
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearAdminToken();
    window.location.href = '/dashboard/admin';
    throw new Error('Admin session expired');
  }

  return response;
}

// Settings API
export async function getSettings(): Promise<AdminSettings> {
  const response = await adminFetch('/v1/admin/settings');
  if (!response.ok) {
    throw new Error('Failed to fetch settings');
  }
  return response.json();
}

export async function updateSettings(updates: {
  signupsEnabled?: boolean;
  defaultEmbedderProvider?: string | null;
  defaultEmbedderModel?: string | null;
  defaultEmbedderApiKey?: string | null;
  defaultEmbedderProviderId?: string | null;
}): Promise<AdminSettings> {
  const response = await adminFetch('/v1/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error('Failed to update settings');
  }
  return response.json();
}

// Beta Signups API
export async function getBetaSignups(): Promise<AdminBetaSignup[]> {
  const response = await adminFetch('/v1/admin/beta/signups');
  if (!response.ok) {
    throw new Error('Failed to fetch beta signups');
  }
  const data = await response.json();
  return data.signups;
}

export async function approveBetaSignup(id: string): Promise<AdminBetaSignup> {
  const response = await adminFetch(`/v1/admin/beta/approve/${id}`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to approve beta signup');
  }
  return response.json();
}

// Smoke Test Runs API

export interface SmokeTestResultDetail {
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms: number;
  error?: string;
}

export interface SmokeTestRunSummary {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  triggeredBy: string;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  durationMs: number | null;
  results: SmokeTestResultDetail[] | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export async function getSmokeTestRuns(): Promise<SmokeTestRunSummary[]> {
  const response = await adminFetch('/v1/admin/smoke-tests');
  if (!response.ok) {
    throw new Error('Failed to fetch smoke test runs');
  }
  const data = await response.json();
  return data.runs;
}

export async function triggerSmokeTestRun(): Promise<{ runId: string }> {
  const response = await adminFetch('/v1/admin/smoke-tests/run', {
    method: 'POST',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to trigger smoke test run');
  }
  return response.json();
}

export async function getSmokeTestRun(id: string): Promise<SmokeTestRunSummary> {
  const response = await adminFetch(`/v1/admin/smoke-tests/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch smoke test run');
  }
  return response.json();
}

// Gateway Provider API

export type ProviderType = 'openai' | 'azure' | 'ollama';

export interface GatewayProvider {
  id: string;
  name: string;
  description: string | null;
  type: ProviderType;
  isDefault: boolean;
  tenantAvailable: boolean;
  availableModels: string[];
  baseUrl?: string | null;
  deployment?: string;
  apiVersion?: string;
  apiKey?: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateGatewayProviderDto {
  name: string;
  description?: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
  availableModels?: string[];
}

export interface UpdateGatewayProviderDto {
  name?: string;
  description?: string;
  apiKey?: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
  availableModels?: string[];
}

export interface ProviderTenantAccessEntry {
  id: string;
  name: string;
  createdAt: string;
}

export async function listGatewayProviders(): Promise<GatewayProvider[]> {
  const response = await adminFetch('/v1/admin/providers');
  if (!response.ok) throw new Error('Failed to fetch providers');
  return response.json();
}

export async function getGatewayProvider(id: string): Promise<GatewayProvider> {
  const response = await adminFetch(`/v1/admin/providers/${id}`);
  if (!response.ok) throw new Error('Failed to fetch provider');
  return response.json();
}

export async function createGatewayProvider(dto: CreateGatewayProviderDto): Promise<GatewayProvider> {
  const response = await adminFetch('/v1/admin/providers', {
    method: 'POST',
    body: JSON.stringify(dto),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create provider');
  }
  return response.json();
}

export async function updateGatewayProvider(id: string, dto: UpdateGatewayProviderDto): Promise<GatewayProvider> {
  const response = await adminFetch(`/v1/admin/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dto),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update provider');
  }
  return response.json();
}

export async function deleteGatewayProvider(id: string): Promise<void> {
  const response = await adminFetch(`/v1/admin/providers/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete provider');
  }
}

export async function setGatewayDefault(id: string): Promise<GatewayProvider> {
  const response = await adminFetch(`/v1/admin/providers/${id}/default`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to set default provider');
  return response.json();
}

export async function updateProviderAvailability(id: string, tenantAvailable: boolean): Promise<GatewayProvider> {
  const response = await adminFetch(`/v1/admin/providers/${id}/availability`, {
    method: 'PUT',
    body: JSON.stringify({ tenantAvailable }),
  });
  if (!response.ok) throw new Error('Failed to update provider availability');
  return response.json();
}

export async function listProviderTenants(id: string): Promise<ProviderTenantAccessEntry[]> {
  const response = await adminFetch(`/v1/admin/providers/${id}/tenants`);
  if (!response.ok) throw new Error('Failed to fetch provider tenants');
  const data = await response.json();
  return data.tenants;
}

export async function grantProviderTenantAccess(providerId: string, tenantId: string): Promise<void> {
  const response = await adminFetch(`/v1/admin/providers/${providerId}/tenants`, {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to grant access');
  }
}

export async function revokeProviderTenantAccess(providerId: string, tenantId: string): Promise<void> {
  const response = await adminFetch(`/v1/admin/providers/${providerId}/tenants/${tenantId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to revoke access');
}

// Tenant list for tenant picker
export async function listAdminTenants(): Promise<{ tenants: AdminTenant[]; total: number }> {
  const response = await adminFetch('/v1/admin/tenants?limit=200');
  if (!response.ok) throw new Error('Failed to fetch tenants');
  return response.json();
}
