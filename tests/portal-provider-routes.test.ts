/**
 * Portal provider management route tests (BYOK / custom providers).
 * Follows the pattern established in tests/portal-kb-routes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { signJwt } from '../src/auth/jwtUtils.js';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockEm, mockProviderSvc } = vi.hoisted(() => {
  const mockEm = {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneOrFail: vi.fn(),
    persist: vi.fn(),
    flush: vi.fn(),
    remove: vi.fn(),
    removeAndFlush: vi.fn(),
    count: vi.fn(),
    populate: vi.fn(),
    fork: vi.fn(),
  };

  const mockProviderSvc = {
    listAvailableProvidersForTenant: vi.fn(),
    listTenantProviders: vi.fn(),
    createTenantProvider: vi.fn(),
    updateTenantProvider: vi.fn(),
    deleteTenantProvider: vi.fn(),
  };

  return { mockEm, mockProviderSvc };
});

vi.mock('../src/orm.js', () => ({
  orm: { em: { fork: vi.fn(() => mockEm) } },
}));

vi.mock('../src/application/services/ProviderManagementService.js', () => ({
  ProviderManagementService: vi.fn(() => mockProviderSvc),
}));

vi.mock('../src/providers/registry.js', () => ({
  evictProvider: vi.fn(),
  getProviderForTenant: vi.fn(),
}));

vi.mock('../src/services/ProvisionService.js', () => ({
  ProvisionService: vi.fn(() => ({})),
}));

vi.mock('../src/services/WeaveService.js', () => ({
  WeaveService: vi.fn(() => ({})),
}));

vi.mock('../src/services/EmbeddingAgentService.js', () => ({
  EmbeddingAgentService: vi.fn(() => ({})),
}));

vi.mock('../src/services/RegistryService.js', () => ({
  RegistryService: vi.fn(() => ({})),
}));

vi.mock('../src/application/services/PortalService.js', () => ({
  PortalService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/application/services/UserManagementService.js', () => ({
  UserManagementService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/application/services/TenantManagementService.js', () => ({
  TenantManagementService: vi.fn().mockImplementation(() => ({})),
}));

// ── Now import the route registrar (after mocks) ───────────────────────────

import { registerPortalRoutes } from '../src/routes/portal.js';

// ── Constants ──────────────────────────────────────────────────────────────

const PORTAL_JWT_SECRET = 'unsafe-portal-secret-change-in-production';
const TEST_USER_ID = 'user-uuid-0001';
const TEST_TENANT_ID = 'tenant-uuid-0001';
const TEST_PROVIDER_ID = 'provider-uuid-0001';

function authToken(userId = TEST_USER_ID, tenantId = TEST_TENANT_ID, role = 'owner'): string {
  return signJwt({ sub: userId, tenantId, role }, PORTAL_JWT_SECRET, 86_400_000);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = mockEm as any;
  });
  registerPortalRoutes(app);
  await app.ready();
  return app;
}

// ── Test Data ──────────────────────────────────────────────────────────────

const mockGatewayProvider = {
  id: 'gw-provider-001',
  name: 'Shared OpenAI',
  type: 'openai',
  description: 'Gateway OpenAI',
  isDefault: true,
  tenantAvailable: true,
  availableModels: ['gpt-4'],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: null,
  // apiKey intentionally omitted (sanitized)
};

const mockCustomProvider = {
  id: TEST_PROVIDER_ID,
  name: 'My OpenAI',
  type: 'openai',
  description: 'Tenant BYOK',
  isDefault: false,
  tenantAvailable: false,
  availableModels: ['gpt-4o'],
  apiKey: 'sk-tenant-key-123',
  baseUrl: null,
  createdAt: '2024-02-01T00:00:00.000Z',
  updatedAt: null,
};

// ── GET /v1/portal/providers ────────────────────────────────────────────────

describe('GET /v1/portal/providers', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProviderSvc.listAvailableProvidersForTenant.mockResolvedValue([mockGatewayProvider]);
    mockProviderSvc.listTenantProviders.mockResolvedValue([mockCustomProvider]);
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with gateway and custom providers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/providers',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateway).toHaveLength(1);
    expect(body.custom).toHaveLength(1);
    expect(body.gateway[0].name).toBe('Shared OpenAI');
    expect(body.gateway[0].apiKey).toBeUndefined();
    expect(body.custom[0].name).toBe('My OpenAI');
    expect(body.custom[0].apiKey).toBe('sk-tenant-key-123');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/providers',
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows member role to read providers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/providers',
      headers: { authorization: `Bearer ${authToken(TEST_USER_ID, TEST_TENANT_ID, 'member')}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /v1/portal/providers ───────────────────────────────────────────────

describe('POST /v1/portal/providers', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProviderSvc.createTenantProvider.mockResolvedValue(mockCustomProvider);
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('creates a tenant provider and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/providers',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      payload: {
        name: 'My OpenAI',
        type: 'openai',
        apiKey: 'sk-tenant-key-123',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('My OpenAI');
    expect(mockProviderSvc.createTenantProvider).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      expect.objectContaining({ name: 'My OpenAI', type: 'openai' }),
    );
  });

  it('returns 409 on duplicate name', async () => {
    mockProviderSvc.createTenantProvider.mockRejectedValue(
      Object.assign(new Error('Provider with name "My OpenAI" already exists for this tenant'), { status: 409 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/providers',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      payload: { name: 'My OpenAI', type: 'openai', apiKey: 'sk-dup' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('returns 403 for member role (owner-only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/providers',
      headers: {
        authorization: `Bearer ${authToken(TEST_USER_ID, TEST_TENANT_ID, 'member')}`,
        'content-type': 'application/json',
      },
      payload: { name: 'test', type: 'openai', apiKey: 'sk-x' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'test', type: 'openai', apiKey: 'sk-x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── PUT /v1/portal/providers/:id ────────────────────────────────────────────

describe('PUT /v1/portal/providers/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProviderSvc.updateTenantProvider.mockResolvedValue({
      ...mockCustomProvider,
      name: 'Updated OpenAI',
    });
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('updates a tenant provider and returns 200', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      payload: { name: 'Updated OpenAI' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated OpenAI');
    expect(mockProviderSvc.updateTenantProvider).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      TEST_PROVIDER_ID,
      expect.objectContaining({ name: 'Updated OpenAI' }),
    );
  });

  it('returns 404 when provider not found', async () => {
    const err = new Error('not found');
    (err as any).name = 'NotFoundError';
    mockProviderSvc.updateTenantProvider.mockRejectedValue(err);

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/portal/providers/nonexistent',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'content-type': 'application/json',
      },
      payload: { name: 'whatever' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for member role (owner-only)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
      headers: {
        authorization: `Bearer ${authToken(TEST_USER_ID, TEST_TENANT_ID, 'member')}`,
        'content-type': 'application/json',
      },
      payload: { name: 'x' },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── DELETE /v1/portal/providers/:id ─────────────────────────────────────────

describe('DELETE /v1/portal/providers/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProviderSvc.deleteTenantProvider.mockResolvedValue(undefined);
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('deletes a tenant provider and returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(204);
    expect(mockProviderSvc.deleteTenantProvider).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      TEST_PROVIDER_ID,
    );
  });

  it('returns 409 when agents reference the provider', async () => {
    mockProviderSvc.deleteTenantProvider.mockRejectedValue(
      Object.assign(
        new Error('Provider is referenced by 2 agent(s). Remove the references before deleting.'),
        { status: 409 },
      ),
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('referenced by');
  });

  it('returns 404 when provider not found', async () => {
    const err = new Error('not found');
    (err as any).name = 'NotFoundError';
    mockProviderSvc.deleteTenantProvider.mockRejectedValue(err);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/portal/providers/nonexistent',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for member role (owner-only)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
      headers: {
        authorization: `Bearer ${authToken(TEST_USER_ID, TEST_TENANT_ID, 'member')}`,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/providers/${TEST_PROVIDER_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
