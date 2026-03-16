/**
 * H-MT1 through H-MT5: Admin API Integration Tests
 * 
 * Tests the admin backend routes and authentication:
 * - H-MT1: Admin auth middleware (login, JWT validation)
 * - H-MT2: Tenant CRUD operations
 * - H-MT3: API key management (create, list, revoke, delete)
 * - H-MT4: Provider config management
 * - H-MT5: Auth regression tests (active key + active tenant)
 * 
 * Uses mocked pg.Pool similar to existing test patterns.
 * Tests use fastify.inject() for in-process testing (no port allocation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scrypt, randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from '../src/routes/admin.js';
import { registerAuthMiddleware, invalidateCachedKey } from '../src/auth.js';

const scryptAsync = promisify(scrypt);

// ── Test constants ─────────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'test-admin-jwt-secret-do-not-use-in-production';
const TEST_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Pre-seeded admin user credentials
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'changeme';

// Test tenant data
const TENANT_ID = 'aaaaaaaa-1111-2222-3333-000000000001';
const TENANT_NAME = 'Test Tenant Alpha';
const API_KEY_ID = 'bbbbbbbb-1111-2222-3333-000000000001';
const API_KEY_RAW = 'loom_sk_testkey123456789012';
const API_KEY_PREFIX = API_KEY_RAW.slice(0, 12);
const API_KEY_HASH = createHash('sha256').update(API_KEY_RAW).digest('hex');

// ── Helper functions ───────────────────────────────────────────────────────

/**
 * Hash a password using scrypt (matching migration format: salt:derivedKey)
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

import { AdminService } from '../src/application/services/AdminService.js';
import type { EntityManager } from '@mikro-orm/core';

function buildMockAdminSvc(options: {
  adminPasswordHash?: string;
  tenants?: Map<string, any>;
  apiKeys?: Map<string, any>;
  providerConfigs?: Map<string, any>;
} = {}): AdminService {
  const tenants = options.tenants ?? new Map();
  const apiKeys = options.apiKeys ?? new Map();
  const providerConfigs = options.providerConfigs ?? new Map();

  return {
    validateAdminLogin: vi.fn().mockImplementation(async (username: string, password: string) => {
      if (username !== ADMIN_USERNAME) return null;
      if (!options.adminPasswordHash) return null;
      const [salt, key] = options.adminPasswordHash.split(':');
      const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
      const { timingSafeEqual } = await import('node:crypto');
      let valid = false;
      try { valid = timingSafeEqual(Buffer.from(key, 'hex'), derivedKey); } catch { return null; }
      if (!valid) return null;
      return { id: 'admin-user-id-1', username: ADMIN_USERNAME };
    }),
    updateAdminLastLogin: vi.fn().mockResolvedValue(undefined),
    createTenant: vi.fn().mockImplementation((name: string) => {
      const newTenant = {
        id: randomBytes(8).toString('hex'),
        name, status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tenants.set(newTenant.id, newTenant);
      return Promise.resolve(newTenant);
    }),
    listTenants: vi.fn().mockImplementation(({ limit, offset, status }: any) => {
      let all = [...tenants.values()];
      if (status) all = all.filter((t: any) => t.status === status);
      const total = all.length;
      const paginated = all.slice(offset, offset + limit);
      return Promise.resolve({ tenants: paginated, total });
    }),
    getTenant: vi.fn().mockImplementation((id: string) => {
      const t = tenants.get(id);
      if (!t) return Promise.resolve(null);
      const keyCount = [...apiKeys.values()].filter((k: any) => k.tenant_id === id).length;
      const pc = providerConfigs.get(id) ?? null;
      return Promise.resolve({ ...t, provider_config: pc, api_key_count: String(keyCount) });
    }),
    updateTenant: vi.fn().mockImplementation((id: string, fields: any) => {
      const t = tenants.get(id);
      if (!t) return Promise.resolve(null);
      const updated = { ...t, ...fields, updated_at: new Date().toISOString() };
      tenants.set(id, updated);
      return Promise.resolve(updated);
    }),
    deleteTenant: vi.fn().mockImplementation((id: string) => {
      const exists = tenants.has(id);
      tenants.delete(id);
      return Promise.resolve(exists);
    }),
    tenantExists: vi.fn().mockImplementation((id: string) => Promise.resolve(tenants.has(id))),
    setProviderConfig: vi.fn().mockImplementation((id: string, config: object) => {
      providerConfigs.set(id, config);
      const t = tenants.get(id);
      if (t) { t.updated_at = new Date().toISOString(); tenants.set(id, t); }
      return Promise.resolve();
    }),
    clearProviderConfig: vi.fn().mockImplementation((id: string) => {
      const existed = providerConfigs.has(id);
      providerConfigs.delete(id);
      return Promise.resolve(existed);
    }),
    createApiKey: vi.fn().mockImplementation((tenantId: string, name: string, _rawKey: string, keyPrefix: string, keyHash: string) => {
      const newKey = {
        id: randomBytes(8).toString('hex'),
        tenant_id: tenantId, name, key_prefix: keyPrefix,
        key_hash: keyHash, status: 'active',
        created_at: new Date().toISOString(), revoked_at: null,
      };
      apiKeys.set(newKey.id, newKey);
      return Promise.resolve({ id: newKey.id, name, key_prefix: keyPrefix, status: 'active', created_at: newKey.created_at });
    }),
    listApiKeys: vi.fn().mockImplementation((tenantId: string) => {
      const keys = [...apiKeys.values()].filter((k: any) => k.tenant_id === tenantId);
      return Promise.resolve(keys.map((k: any) => ({ id: k.id, name: k.name, key_prefix: k.key_prefix, status: k.status, created_at: k.created_at, revoked_at: k.revoked_at })));
    }),
    getApiKeyHash: vi.fn().mockImplementation((keyId: string, tenantId: string) => {
      const key = apiKeys.get(keyId);
      if (!key || key.tenant_id !== tenantId) return Promise.resolve(null);
      return Promise.resolve(key.key_hash);
    }),
    hardDeleteApiKey: vi.fn().mockImplementation((keyId: string, _tenantId: string) => {
      apiKeys.delete(keyId);
      return Promise.resolve();
    }),
    revokeApiKey: vi.fn().mockImplementation((keyId: string, tenantId: string) => {
      const key = apiKeys.get(keyId);
      if (!key || key.tenant_id !== tenantId) return Promise.resolve(null);
      key.status = 'revoked';
      key.revoked_at = new Date().toISOString();
      apiKeys.set(keyId, key);
      return Promise.resolve(key.key_hash);
    }),
    listTraces: vi.fn().mockResolvedValue([]),
  } as unknown as AdminService;
}

function buildMockEm(options: { apiKeys?: Map<string, any>; tenants?: Map<string, any>; providerConfigs?: Map<string, any> } = {}): EntityManager {
  const apiKeys = options.apiKeys ?? new Map();
  const tenants = options.tenants ?? new Map();
  const providerConfigs = options.providerConfigs ?? new Map();

  const mockEm = {
    findOne: vi.fn().mockImplementation(async (_Entity: any, where: any, _opts?: any) => {
      if (where && where.keyHash !== undefined) {
        const key = [...apiKeys.values()].find((k: any) => k.key_hash === where.keyHash && k.status === where.status);
        if (!key) return null;
        const tenant = tenants.get(key.tenant_id);
        if (!tenant) return null;
        const tenantProviderConfig = providerConfigs.get(tenant.id) ?? null;
        return {
          keyHash: key.key_hash,
          status: key.status,
          agent: null,
          tenant: {
            id: tenant.id,
            name: tenant.name,
            status: tenant.status,
            parentId: null,
            providerConfig: tenantProviderConfig,
            systemPrompt: null,
            skills: null,
            mcpEndpoints: null,
            availableModels: null,
          },
        };
      }
      return null;
    }),
    find: vi.fn().mockImplementation(async (_Entity: any, where: any) => {
      if (where && where.tenant !== undefined) {
        const tenantId = where.tenant;
        return [...apiKeys.values()]
          .filter((k: any) => k.tenant_id === tenantId)
          .map((k: any) => ({ keyHash: k.key_hash }));
      }
      return [];
    }),
    persist: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as EntityManager;

  // Add fork() method that returns the same mock
  (mockEm as any).fork = vi.fn(() => mockEm);

  return mockEm;
}

// Global mock admin service instance — set by buildApp, returned by mocked AdminService constructor
let _mockAdminSvc: AdminService;

vi.mock('../src/application/services/AdminService.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/application/services/AdminService.js')>();
  return {
    ...mod,
    AdminService: vi.fn().mockImplementation(() => _mockAdminSvc),
  };
});

async function buildApp(adminService: AdminService, mockEm: EntityManager): Promise<FastifyInstance> {
  _mockAdminSvc = adminService;
  const app = Fastify({ logger: false });
  // Per-request EM forking (simulated for tests)
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = mockEm;
  });
  registerAuthMiddleware(app);
  registerAdminRoutes(app);
  app.post('/v1/chat/completions', async (request, reply) => {
    return reply.send({ tenant: request.tenant });
  });
  await app.ready();
  return app;
}

// ── H-MT1: Admin auth middleware ───────────────────────────────────────────

describe('H-MT1: Admin authentication middleware', () => {
  let app: FastifyInstance;
  let adminPasswordHash: string;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_JWT_SECRET = TEST_JWT_SECRET;
    adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    app = await buildApp(buildMockAdminSvc({ adminPasswordHash }), buildMockEm());
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ADMIN_JWT_SECRET;
  });

  it('login with valid credentials returns JWT token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; username: string }>();
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
    expect(body.username).toBe(ADMIN_USERNAME);
  });

  it('login with invalid password returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: 'wrongpassword' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Invalid credentials');
  });

  it('login with unknown username returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: 'unknownuser', password: ADMIN_PASSWORD },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Invalid credentials');
  });

  it('protected route with no token returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('Unauthorized');
  });

  it('protected route with invalid token returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: 'Bearer invalid-token-xyz' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('Unauthorized');
  });

  it('protected route with valid token passes through', async () => {
    // First login to get token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    const { token } = loginRes.json<{ token: string }>();

    // Use token to access protected route
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── H-MT2: Tenant CRUD ─────────────────────────────────────────────────────

describe('H-MT2: Tenant CRUD operations', () => {
  let app: FastifyInstance;
  let token: string;
  let tenants: Map<string, any>;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_JWT_SECRET = TEST_JWT_SECRET;
    
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    
    app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants }), buildMockEm({ tenants }));

    // Get admin token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    token = loginRes.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ADMIN_JWT_SECRET;
  });

  it('create tenant with valid name returns 201 and tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'New Tenant Beta' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; status: string }>();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('New Tenant Beta');
    expect(body.status).toBe('active');
  });

  it('create tenant with missing name returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('name');
  });

  it('list tenants returns array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenants: any[]; total: number }>();
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('list tenants with status filter returns filtered results', async () => {
    // Add an inactive tenant
    const inactiveTenantId = 'cccccccc-1111-2222-3333-000000000001';
    tenants.set(inactiveTenantId, {
      id: inactiveTenantId,
      name: 'Inactive Tenant',
      status: 'inactive',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants?status=inactive',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenants: any[] }>();
    expect(body.tenants.every((t) => t.status === 'inactive')).toBe(true);
  });

  it('get tenant returns tenant with provider config summary and key count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${TENANT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string; apiKeyCount: number }>();
    expect(body.id).toBe(TENANT_ID);
    expect(body.name).toBe(TENANT_NAME);
    expect(typeof body.apiKeyCount).toBe('number');
  });

  it('get tenant with non-existent id returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants/nonexistent-id',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('not found');
  });

  it('update tenant name returns updated name', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TENANT_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Updated Tenant Name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string }>();
    expect(body.name).toBe('Updated Tenant Name');
  });

  it('update tenant status to inactive returns 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${TENANT_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.status).toBe('inactive');
  });

  it('hard delete without confirm=true returns 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('confirm');
  });

  it('hard delete with confirm=true returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}?confirm=true`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
  });
});

// ── H-MT3: API key management ──────────────────────────────────────────────

describe('H-MT3: API key management', () => {
  let app: FastifyInstance;
  let token: string;
  let tenants: Map<string, any>;
  let apiKeys: Map<string, any>;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_JWT_SECRET = TEST_JWT_SECRET;
    
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    apiKeys = new Map([
      [API_KEY_ID, {
        id: API_KEY_ID,
        tenant_id: TENANT_ID,
        name: 'Test API Key',
        key_prefix: API_KEY_PREFIX,
        key_hash: API_KEY_HASH,
        status: 'active',
        created_at: new Date().toISOString(),
        revoked_at: null,
      }],
    ]);
    
    app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants, apiKeys }), buildMockEm({ tenants, apiKeys }));

    // Get admin token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    token = loginRes.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ADMIN_JWT_SECRET;
  });

  it('create API key returns 201 with raw key in response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${TENANT_ID}/api-keys`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'New Production Key' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; key: string; keyPrefix: string }>();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('New Production Key');
    expect(body.key).toBeDefined();
    expect(body.key).toMatch(/^loom_sk_/);
    expect(body.keyPrefix).toBe(body.key.slice(0, 12));
  });

  it('create API key for non-existent tenant returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tenants/nonexistent-tenant-id/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Key for Missing Tenant' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('not found');
  });

  it('list API keys returns array without key_hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${TENANT_ID}/api-keys`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ apiKeys: any[] }>();
    expect(Array.isArray(body.apiKeys)).toBe(true);
    expect(body.apiKeys.length).toBeGreaterThan(0);
    // Ensure key_hash is not exposed
    body.apiKeys.forEach((key) => {
      expect(key.key_hash).toBeUndefined();
      expect(key.keyPrefix).toBeDefined();
    });
  });

  it('revoke key (default) returns 204 and key status becomes revoked', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}/api-keys/${API_KEY_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    
    // Verify key is revoked
    const key = apiKeys.get(API_KEY_ID);
    expect(key?.status).toBe('revoked');
    expect(key?.revoked_at).toBeDefined();
  });

  it('hard delete key with permanent=true returns 204 and row is gone', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}/api-keys/${API_KEY_ID}?permanent=true`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    
    // Verify key is deleted
    expect(apiKeys.has(API_KEY_ID)).toBe(false);
  });
});

// ── H-MT4: Provider config ─────────────────────────────────────────────────

describe('H-MT4: Provider config management', () => {
  let app: FastifyInstance;
  let token: string;
  let tenants: Map<string, any>;
  let providerConfigs: Map<string, any>;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_JWT_SECRET = TEST_JWT_SECRET;
    
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    providerConfigs = new Map();
    
    app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants, providerConfigs }), buildMockEm({ tenants, providerConfigs }));

    // Get admin token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    token = loginRes.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ADMIN_JWT_SECRET;
  });

  it('set provider config with apiKey returns 200 and hasApiKey: true', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider: 'openai',
        apiKey: 'sk-test-openai-key-12345',
        baseUrl: 'https://api.openai.com/v1',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerConfig: any }>();
    expect(body.providerConfig.provider).toBe('openai');
    expect(body.providerConfig.hasApiKey).toBe(true);
    expect(body.providerConfig.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('set provider config does not return raw apiKey in response', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider: 'azure',
        apiKey: 'secret-azure-key-xyz789',
        deployment: 'gpt-4',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerConfig: any }>();
    expect(body.providerConfig.apiKey).toBeUndefined();
    expect(body.providerConfig.hasApiKey).toBe(true);
  });

  it('remove provider config returns 204', async () => {
    // First set a config
    await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'openai', apiKey: 'test-key' },
    });

    // Then remove it
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
  });

  it('get tenant after removing config shows providerConfig: null', async () => {
    // Set config
    await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'openai', apiKey: 'test' },
    });

    // Remove config
    await app.inject({
      method: 'DELETE',
      url: `/v1/admin/tenants/${TENANT_ID}/provider-config`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Get tenant details
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${TENANT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerConfig: any }>();
    expect(body.providerConfig).toBeNull();
  });
});

// ── H-MT5: Auth regression ─────────────────────────────────────────────────

describe('H-MT5: Auth regression (active key + active tenant)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_JWT_SECRET = TEST_JWT_SECRET;
    // Clear cache before each test to avoid cross-test contamination
    invalidateCachedKey(API_KEY_HASH);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ADMIN_JWT_SECRET;
  });

  it('active key + active tenant allows proxy auth to pass', async () => {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    const tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    const apiKeys = new Map([
      [API_KEY_ID, {
        id: API_KEY_ID,
        tenant_id: TENANT_ID,
        name: 'Active Key',
        key_prefix: API_KEY_PREFIX,
        key_hash: API_KEY_HASH,
        status: 'active',
        created_at: new Date().toISOString(),
        revoked_at: null,
      }],
    ]);
    
    const app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants, apiKeys }), buildMockEm({ tenants, apiKeys }));

    // Simulate a proxy request with valid API key
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${API_KEY_RAW}` },
      payload: { model: 'gpt-4', messages: [] },
    });

    await app.close();

    // Auth middleware should attach tenant context (200 or provider error, not 401/403)
    expect([200, 500]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it('active key + inactive tenant returns 401', async () => {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    const tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'inactive', // Tenant is inactive
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    const apiKeys = new Map([
      [API_KEY_ID, {
        id: API_KEY_ID,
        tenant_id: TENANT_ID,
        name: 'Active Key',
        key_prefix: API_KEY_PREFIX,
        key_hash: API_KEY_HASH,
        status: 'active',
        created_at: new Date().toISOString(),
        revoked_at: null,
      }],
    ]);

    const app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants, apiKeys }), buildMockEm({ tenants, apiKeys }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${API_KEY_RAW}` },
      payload: { model: 'gpt-4', messages: [] },
    });

    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it('revoked key + active tenant returns 401', async () => {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    const tenants = new Map([
      [TENANT_ID, {
        id: TENANT_ID,
        name: TENANT_NAME,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    ]);
    const apiKeys = new Map([
      [API_KEY_ID, {
        id: API_KEY_ID,
        tenant_id: TENANT_ID,
        name: 'Revoked Key',
        key_prefix: API_KEY_PREFIX,
        key_hash: API_KEY_HASH,
        status: 'revoked', // Key is revoked
        created_at: new Date().toISOString(),
        revoked_at: new Date().toISOString(),
      }],
    ]);

    const app = await buildApp(buildMockAdminSvc({ adminPasswordHash, tenants, apiKeys }), buildMockEm({ tenants, apiKeys }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${API_KEY_RAW}` },
      payload: { model: 'gpt-4', messages: [] },
    });

    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
