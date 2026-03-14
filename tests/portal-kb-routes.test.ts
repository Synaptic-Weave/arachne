/**
 * Portal KB and deployment route tests.
 * Follows the pattern established in tests/portal-routes.test.ts.
 *
 * Mocks:
 *  - src/orm.js            → provides a controllable mock EntityManager via fork()
 *  - src/services/ProvisionService.js → controls deployment-route behaviour
 *  - src/providers/registry.js        → prevents real provider initialisation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { signJwt } from '../src/auth/jwtUtils.js';

// ── Hoisted mocks (must run before module imports) ───────────────────────────

const { mockEm, mockProvisionInstance, mockWeaveService, mockEmbeddingAgentService, mockRegistryServiceInstance } = vi.hoisted(() => {
  const mockProvisionInstance = {
    listDeployments: vi.fn(),
    getDeployment: vi.fn(),
    unprovision: vi.fn(),
    deploy: vi.fn(),
  };

  const mockEm = {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneOrFail: vi.fn(),
    persist: vi.fn(),
    flush: vi.fn(),
    remove: vi.fn(),
    count: vi.fn(),
    populate: vi.fn(),
  };

  const mockWeaveService = {
    chunkText: vi.fn(),
    embedTexts: vi.fn(),
    computePreprocessingHash: vi.fn(),
  };

  const mockEmbeddingAgentService = {
    resolveEmbedder: vi.fn(),
  };

  const mockRegistryServiceInstance = {
    push: vi.fn(),
  };

  return { mockEm, mockProvisionInstance, mockWeaveService, mockEmbeddingAgentService, mockRegistryServiceInstance };
});

vi.mock('../src/orm.js', () => ({
  orm: { em: { fork: vi.fn(() => mockEm) } },
}));

vi.mock('../src/services/ProvisionService.js', () => ({
  ProvisionService: vi.fn(() => mockProvisionInstance),
}));

vi.mock('../src/providers/registry.js', () => ({
  evictProvider: vi.fn(),
  getProviderForTenant: vi.fn(),
}));

vi.mock('../src/services/WeaveService.js', () => ({
  WeaveService: vi.fn(() => mockWeaveService),
}));

vi.mock('../src/services/EmbeddingAgentService.js', () => ({
  EmbeddingAgentService: vi.fn(() => mockEmbeddingAgentService),
}));

vi.mock('../src/services/RegistryService.js', () => ({
  RegistryService: vi.fn(() => mockRegistryServiceInstance),
}));

// ── Now import the route registrar (after mocks are set up) ──────────────────

import { registerPortalRoutes } from '../src/routes/portal.js';
import { PortalService } from '../src/application/services/PortalService.js';
import { ConversationManagementService } from '../src/application/services/ConversationManagementService.js';
import { UserManagementService } from '../src/application/services/UserManagementService.js';
import { TenantManagementService } from '../src/application/services/TenantManagementService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const PORTAL_JWT_SECRET = 'unsafe-portal-secret-change-in-production';
const TEST_USER_ID = 'user-uuid-0001';
const TEST_TENANT_ID = 'tenant-uuid-0001';
const TEST_KB_ID = 'artifact-uuid-0001';
const TEST_DEPLOYMENT_ID = 'deployment-uuid-0001';

function authToken(userId = TEST_USER_ID, tenantId = TEST_TENANT_ID, role = 'owner'): string {
  return signJwt({ sub: userId, tenantId, role }, PORTAL_JWT_SECRET, 86_400_000);
}

// ── Minimal service stubs (portal routes need these injected) ────────────────

function buildStubPortalSvc(): PortalService {
  return {} as unknown as PortalService;
}
function buildStubConvSvc(): ConversationManagementService {
  return {} as unknown as ConversationManagementService;
}
function buildStubUserMgmtSvc(): UserManagementService {
  return {} as unknown as UserManagementService;
}
function buildStubTenantMgmtSvc(): TenantManagementService {
  return {} as unknown as TenantManagementService;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerPortalRoutes(
    app,
    buildStubPortalSvc(),
    buildStubConvSvc(),
    buildStubUserMgmtSvc(),
    buildStubTenantMgmtSvc(),
  );
  await app.ready();
  return app;
}

// Shared mock KB artifact shape returned from em.find / em.findOne
const mockKbArtifact = {
  id: TEST_KB_ID,
  name: 'my-docs',
  org: 'myorg',
  version: 'v1',
  kind: 'KnowledgeBase',
  chunkCount: 10,
  createdAt: new Date('2024-01-01'),
  tags: [{ tag: 'latest' }],
  vectorSpace: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    preprocessingHash: 'abc123',
  },
};

const mockDeployment = {
  id: TEST_DEPLOYMENT_ID,
  status: 'READY',
  environment: 'production',
  deployedAt: new Date('2024-01-02'),
  createdAt: new Date('2024-01-02'),
  artifact: {
    id: TEST_KB_ID,
    name: 'my-docs',
    version: 'v1',
    kind: 'KnowledgeBase',
  },
};

// ── GET /v1/portal/knowledge-bases ──────────────────────────────────────────

describe('GET /v1/portal/knowledge-bases', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockEm.find.mockResolvedValue([mockKbArtifact]);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with list of knowledge bases including org, version, vectorSpace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/knowledge-bases',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ knowledgeBases: { id: string; name: string; org: string; version: string; vectorSpace: string }[] }>();
    expect(Array.isArray(body.knowledgeBases)).toBe(true);
    expect(body.knowledgeBases.length).toBe(1);
    expect(body.knowledgeBases[0].id).toBe(TEST_KB_ID);
    expect(body.knowledgeBases[0].name).toBe('my-docs');
    expect(body.knowledgeBases[0].org).toBe('myorg');
    expect(body.knowledgeBases[0].version).toBe('v1');
    expect(body.knowledgeBases[0].vectorSpace).toBe('openai/text-embedding-3-small (1536d)');
  });

  it('returns 401 without an auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/knowledge-bases',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty array when tenant has no knowledge bases', async () => {
    mockEm.find.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/knowledge-bases',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ knowledgeBases: [] });
  });
});

// ── GET /v1/portal/knowledge-bases/:id ──────────────────────────────────────

describe('GET /v1/portal/knowledge-bases/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockEm.findOne.mockResolvedValue(mockKbArtifact);
    mockEm.count.mockResolvedValue(10);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with knowledge base details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/portal/knowledge-bases/${TEST_KB_ID}`,
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      id: string;
      name: string;
      chunkCount: number;
      searchReady: boolean;
    }>();
    expect(body.id).toBe(TEST_KB_ID);
    expect(body.name).toBe('my-docs');
    expect(body.chunkCount).toBe(10);
    expect(body.searchReady).toBe(true);
  });

  it('returns 404 when knowledge base not found', async () => {
    mockEm.findOne.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/knowledge-bases/nonexistent-id',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('returns 401 without an auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/portal/knowledge-bases/${TEST_KB_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── DELETE /v1/portal/knowledge-bases/:id ───────────────────────────────────

describe('DELETE /v1/portal/knowledge-bases/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockEm.find.mockResolvedValue([]);     // KbChunk.find → empty
    mockEm.remove.mockReturnValue(undefined);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with deleted:true on success', async () => {
    mockEm.findOne.mockResolvedValue(mockKbArtifact);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/knowledge-bases/${TEST_KB_ID}`,
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ deleted: boolean }>().deleted).toBe(true);
    expect(mockEm.flush).toHaveBeenCalled();
  });

  it('returns 404 when knowledge base not found', async () => {
    mockEm.findOne.mockResolvedValue(null);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/portal/knowledge-bases/nonexistent-id',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('returns 401 without an auth token', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/knowledge-bases/${TEST_KB_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /v1/portal/deployments ───────────────────────────────────────────────

describe('GET /v1/portal/deployments', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockProvisionInstance.listDeployments.mockResolvedValue([mockDeployment]);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with list of deployments', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/deployments',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ deployments: { id: string; status: string }[] }>();
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.deployments.length).toBe(1);
    expect(body.deployments[0].id).toBe(TEST_DEPLOYMENT_ID);
    expect(body.deployments[0].status).toBe('READY');
  });

  it('returns 401 without an auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/deployments',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty array when no deployments exist', async () => {
    mockProvisionInstance.listDeployments.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/deployments',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deployments: [] });
  });
});

// ── DELETE /v1/portal/deployments/:id ────────────────────────────────────────

describe('DELETE /v1/portal/deployments/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockProvisionInstance.unprovision.mockResolvedValue(true);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with success:true on successful unprovision', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/deployments/${TEST_DEPLOYMENT_ID}`,
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(true);
    expect(mockProvisionInstance.unprovision).toHaveBeenCalledWith(
      TEST_DEPLOYMENT_ID,
      TEST_TENANT_ID,
      expect.anything(),
    );
  });

  it('returns 404 when deployment not found', async () => {
    mockProvisionInstance.unprovision.mockResolvedValue(false);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/portal/deployments/nonexistent-id',
      headers: { authorization: `Bearer ${authToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('returns 401 without an auth token', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/portal/deployments/${TEST_DEPLOYMENT_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /v1/portal/knowledge-bases ─────────────────────────────────────────

import FormData from 'form-data';

describe('POST /v1/portal/knowledge-bases', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEm.flush.mockResolvedValue(undefined);
    mockEm.findOne.mockResolvedValue({ id: TEST_TENANT_ID, orgSlug: 'myorg' });
    mockEmbeddingAgentService.resolveEmbedder.mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      apiKey: 'sk-test',
    });
    mockWeaveService.chunkText.mockReturnValue(['chunk one', 'chunk two']);
    mockWeaveService.embedTexts.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);
    mockWeaveService.computePreprocessingHash.mockReturnValue('hash123');
    mockRegistryServiceInstance.push.mockResolvedValue({
      artifactId: 'new-kb-id',
      ref: 'myorg/test-kb:latest',
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a knowledge base from multipart upload', async () => {
    const form = new FormData();
    form.append('name', 'test-kb');
    form.append('files', Buffer.from('Hello world document'), { filename: 'test.txt', contentType: 'text/plain' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: {
        authorization: `Bearer ${authToken()}`,
        ...form.getHeaders(),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; name: string; org: string; ref: string; chunkCount: number }>();
    expect(body.id).toBe('new-kb-id');
    expect(body.name).toBe('test-kb');
    expect(body.org).toBe('myorg');
    expect(body.ref).toBe('myorg/test-kb:latest');
    expect(body.chunkCount).toBe(2);
    expect(mockWeaveService.chunkText).toHaveBeenCalled();
    expect(mockWeaveService.embedTexts).toHaveBeenCalled();
    expect(mockRegistryServiceInstance.push).toHaveBeenCalled();
  });

  it('returns 400 when name is missing', async () => {
    const form = new FormData();
    form.append('files', Buffer.from('content'), { filename: 'test.txt', contentType: 'text/plain' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: {
        authorization: `Bearer ${authToken()}`,
        ...form.getHeaders(),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Name is required');
  });

  it('returns 400 when no files are uploaded', async () => {
    const form = new FormData();
    form.append('name', 'test-kb');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: {
        authorization: `Bearer ${authToken()}`,
        ...form.getHeaders(),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('file');
  });

  it('returns 400 when embedder is not configured', async () => {
    mockEmbeddingAgentService.resolveEmbedder.mockRejectedValue(new Error('not configured'));

    const form = new FormData();
    form.append('name', 'test-kb');
    form.append('files', Buffer.from('content'), { filename: 'test.txt', contentType: 'text/plain' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: {
        authorization: `Bearer ${authToken()}`,
        ...form.getHeaders(),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Embedding not configured');
  });

  it('returns 401 without auth', async () => {
    const form = new FormData();
    form.append('name', 'test-kb');
    form.append('files', Buffer.from('content'), { filename: 'test.txt', contentType: 'text/plain' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for non-owner role', async () => {
    const form = new FormData();
    form.append('name', 'test-kb');
    form.append('files', Buffer.from('content'), { filename: 'test.txt', contentType: 'text/plain' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/knowledge-bases',
      headers: {
        authorization: `Bearer ${authToken(TEST_USER_ID, TEST_TENANT_ID, 'member')}`,
        ...form.getHeaders(),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(403);
  });
});
