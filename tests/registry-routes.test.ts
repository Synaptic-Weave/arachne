/**
 * HTTP-layer tests for src/routes/registry.ts
 * Mocks RegistryService and ProvisionService — service logic is tested in registry-services.test.ts.
 *
 * Auth: uses real registryAuth middleware with JWTs signed against the default dev secret.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { signJwt } from '../src/auth/jwtUtils.js';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockRegistryInstance, mockProvisionInstance, mockEmbeddingInstance } = vi.hoisted(() => {
  const mockRegistryInstance = {
    push: vi.fn(),
    list: vi.fn(),
    pull: vi.fn(),
    delete: vi.fn(),
    resolve: vi.fn(),
  };
  const mockProvisionInstance = {
    deploy: vi.fn(),
    listDeployments: vi.fn(),
    unprovision: vi.fn(),
    findByName: vi.fn(),
    rotateToken: vi.fn(),
  };
  const mockEmbeddingInstance = {
    resolveEmbedder: vi.fn(),
    embedTexts: vi.fn(),
    bootstrapSystemEmbedder: vi.fn(),
    bootstrapAllTenants: vi.fn(),
  };
  return { mockRegistryInstance, mockProvisionInstance, mockEmbeddingInstance };
});

vi.mock('../src/services/RegistryService.js', () => ({
  RegistryService: vi.fn(() => mockRegistryInstance),
}));

vi.mock('../src/services/ProvisionService.js', () => ({
  ProvisionService: vi.fn(() => mockProvisionInstance),
}));

vi.mock('../src/services/EmbeddingAgentService.js', () => ({
  EmbeddingAgentService: vi.fn(() => mockEmbeddingInstance),
}));

import { registerRegistryRoutes } from '../src/routes/registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_SECRET = 'unsafe-registry-secret-change-in-production';
const TENANT_ID = 'tenant-test-001';
const ORG_SLUG = 'test-org';

function makeToken(scopes: string[], extra: Record<string, unknown> = {}): string {
  return signJwt(
    { sub: 'user-1', tenantId: TENANT_ID, orgSlug: ORG_SLUG, scopes, ...extra },
    REGISTRY_SECRET,
    86_400_000,
  );
}

const pushToken   = makeToken(['registry:push']);
const readToken   = makeToken(['artifact:read']);
const deployToken = makeToken(['deploy:write']);

// ── Test app builder ─────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Per-request EM forking (simulated for tests)
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = {
      findOne: vi.fn().mockResolvedValue({ id: TENANT_ID, orgSlug: ORG_SLUG }),
    } as any;
  });
  registerRegistryRoutes(app);
  await app.ready();
  return app;
}

// ── Multipart body builder ───────────────────────────────────────────────────

function buildMultipart(
  fields: Record<string, string>,
  fileContent = Buffer.from('fake-bundle-data'),
): { body: Buffer; boundary: string } {
  const boundary = '----TestBoundary7MA4YWxkTrZu0gW';
  const parts: Buffer[] = [];

  // file part
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="bundle"; filename="bundle.tgz"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(fileContent);
  parts.push(Buffer.from('\r\n'));

  // field parts
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

function buildMultipartNoFile(fields: Record<string, string>): { body: Buffer; boundary: string } {
  const boundary = '----TestBoundary7MA4YWxkTrZu0gW';
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

// ── POST /v1/registry/push ───────────────────────────────────────────────────

describe('POST /v1/registry/push', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('happy path: returns 201 with artifactId on successful push', async () => {
    mockRegistryInstance.push.mockResolvedValue({ artifactId: 'art-001', ref: 'test-org/my-kb:latest' });

    const { body, boundary } = buildMultipart({ name: 'my-kb', kind: 'KnowledgeBase', tag: 'latest' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.artifactId).toBe('art-001');
    expect(json.ref).toBe('test-org/my-kb:latest');
  });

  it('returns 400 when bundle file is missing', async () => {
    const { body, boundary } = buildMultipartNoFile({ name: 'my-kb', kind: 'KnowledgeBase' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/missing bundle file/i);
  });

  it('returns 400 when name field is missing', async () => {
    const { body, boundary } = buildMultipart({ kind: 'KnowledgeBase' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/missing name/i);
  });

  it('returns 400 when kind field is missing', async () => {
    const { body, boundary } = buildMultipart({ name: 'my-kb' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/missing kind/i);
  });

  it('is idempotent: returns 201 when sha256 already exists (service handles dedup)', async () => {
    // Service returns the existing artifact — route always sends 201
    mockRegistryInstance.push.mockResolvedValue({ artifactId: 'art-existing', ref: 'test-org/my-kb:latest' });

    const { body, boundary } = buildMultipart({ name: 'my-kb', kind: 'KnowledgeBase' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().artifactId).toBe('art-existing');
  });

  it('returns 400 when provided sha256 does not match computed sha256', async () => {
    const { body, boundary } = buildMultipart({ name: 'my-kb', kind: 'KnowledgeBase', sha256: 'wrong-hash' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${pushToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sha256 mismatch/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/registry/push' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks registry:push scope', async () => {
    const wrongScopeToken = makeToken(['artifact:read']);
    const { body, boundary } = buildMultipart({ name: 'x', kind: 'y' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${wrongScopeToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── Member-role scope enforcement ────────────────────────────────────────────

describe('Member-role JWT (artifact:read only)', () => {
  let app: FastifyInstance;
  const memberToken = makeToken(['artifact:read']);

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('can list artifacts with artifact:read scope', async () => {
    mockRegistryInstance.list.mockResolvedValue([
      { name: 'shared-kb', tags: ['latest'], kind: 'KnowledgeBase', latestVersion: 'v1' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].name).toBe('shared-kb');
  });

  it('cannot push artifacts (gets 403)', async () => {
    const { body, boundary } = buildMultipart({ name: 'my-kb', kind: 'KnowledgeBase', tag: 'latest' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── GET /v1/registry/list ────────────────────────────────────────────────────

describe('GET /v1/registry/list', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with artifact list for tenant', async () => {
    const artifacts = [
      { name: 'my-kb', tags: ['latest', 'v1'], kind: 'KnowledgeBase', latestVersion: 'v1' },
    ];
    mockRegistryInstance.list.mockResolvedValue(artifacts);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toHaveLength(1);
    expect(json[0].name).toBe('my-kb');
  });

  it('returns empty array when no artifacts exist', async () => {
    mockRegistryInstance.list.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('passes orgSlug from token when org query param is not provided', async () => {
    mockRegistryInstance.list.mockResolvedValue([]);

    await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(mockRegistryInstance.list).toHaveBeenCalledWith(TENANT_ID, ORG_SLUG, expect.anything());
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/registry/list' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks artifact:read scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${pushToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── GET /v1/registry/pull/:org/:name/:tag ────────────────────────────────────

describe('GET /v1/registry/pull/:org/:name/:tag', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with bundle binary when artifact is found', async () => {
    const bundleData = Buffer.from('fake-bundle-content');
    mockRegistryInstance.pull.mockResolvedValue(bundleData);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/pull/test-org/my-kb/latest',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('returns 404 when artifact is not found', async () => {
    mockRegistryInstance.pull.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/pull/test-org/missing-kb/latest',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/registry/pull/org/name/tag' });
    expect(res.statusCode).toBe(401);
  });
});

// ── DELETE /v1/registry/:org/:name/:tag ──────────────────────────────────────

describe('DELETE /v1/registry/:org/:name/:tag', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with deleted: true on success', async () => {
    mockRegistryInstance.delete.mockResolvedValue(true);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/test-org/my-kb/latest',
      headers: { authorization: `Bearer ${pushToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it('returns 404 when artifact is not found', async () => {
    mockRegistryInstance.delete.mockResolvedValue(false);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/test-org/missing/latest',
      headers: { authorization: `Bearer ${pushToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/registry/org/name/tag' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks registry:push scope', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/org/name/tag',
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── POST /v1/registry/deployments/:org/:name/:tag ────────────────────────────

describe('POST /v1/registry/deployments/:org/:name/:tag', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 201 when deployment succeeds with READY status', async () => {
    mockProvisionInstance.deploy.mockResolvedValue({
      deploymentId: 'deploy-001',
      status: 'READY',
      runtimeToken: 'rt-token-xyz',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/test-org/my-kb/latest?environment=production',
      headers: {
        authorization: `Bearer ${deployToken}`,
      },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.deploymentId).toBe('deploy-001');
    expect(json.status).toBe('READY');
  });

  it('defaults to production environment when query param is omitted', async () => {
    mockProvisionInstance.deploy.mockResolvedValue({
      deploymentId: 'deploy-003',
      status: 'READY',
      runtimeToken: 'rt-token-xyz',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/test-org/my-kb/latest',
      headers: {
        authorization: `Bearer ${deployToken}`,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockProvisionInstance.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'production',
      }),
      expect.anything(),
    );
  });

  it('returns 200 when deploy returns FAILED status', async () => {
    mockProvisionInstance.deploy.mockResolvedValue({
      deploymentId: 'deploy-002',
      status: 'FAILED',
      errorMessage: 'Artifact not found',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/test-org/missing-kb/latest',
      headers: {
        authorization: `Bearer ${deployToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('FAILED');
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/o/n/t',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks deploy:write scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/o/n/t',
      headers: {
        authorization: `Bearer ${readToken}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── GET /v1/registry/deployments ─────────────────────────────────────────────

describe('GET /v1/registry/deployments', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with deployment list', async () => {
    mockProvisionInstance.listDeployments.mockResolvedValue([
      { id: 'deploy-1', status: 'READY', environment: 'production' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/deployments',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/registry/deployments' });
    expect(res.statusCode).toBe(401);
  });
});

// ── DELETE /v1/registry/deployments/:id ──────────────────────────────────────

describe('DELETE /v1/registry/deployments/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with success: true when unprovision succeeds', async () => {
    mockProvisionInstance.unprovision.mockResolvedValue(true);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/deployments/deploy-001',
      headers: { authorization: `Bearer ${deployToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('returns 404 when deployment is not found', async () => {
    mockProvisionInstance.unprovision.mockResolvedValue(false);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/deployments/nonexistent',
      headers: { authorization: `Bearer ${deployToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/registry/deployments/deploy-001' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks deploy:write scope', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/registry/deployments/deploy-001',
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── POST /v1/registry/deployments with --name query param ───────────────────

describe('POST /v1/registry/deployments with name query param', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('passes name query param to provisionService.deploy', async () => {
    mockProvisionInstance.deploy.mockResolvedValue({
      deploymentId: 'deploy-named',
      name: 'my-custom-name',
      status: 'READY',
      runtimeToken: 'rt-token-xyz',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/test-org/my-kb/latest?environment=production&name=my-custom-name',
      headers: {
        authorization: `Bearer ${deployToken}`,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockProvisionInstance.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-custom-name',
      }),
      expect.anything(),
    );
    expect(res.json().name).toBe('my-custom-name');
  });
});

// ── GET /v1/registry/deployments/by-name/:name ─────────────────────────────

describe('GET /v1/registry/deployments/by-name/:name', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with deployment when found', async () => {
    const mockDeployment = {
      id: 'deploy-001',
      name: 'my-agent-production',
      status: 'READY',
      environment: 'production',
      runtimeToken: 'rt-token-xyz',
      artifact: { id: 'art-001', name: 'my-agent', kind: 'Agent' },
    };
    mockProvisionInstance.findByName.mockResolvedValue(mockDeployment);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/deployments/by-name/my-agent-production',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.name).toBe('my-agent-production');
    expect(json.runtimeToken).toBe('rt-token-xyz');
    expect(mockProvisionInstance.findByName).toHaveBeenCalledWith(
      'my-agent-production',
      TENANT_ID,
      expect.anything(),
    );
  });

  it('returns 404 when deployment is not found', async () => {
    mockProvisionInstance.findByName.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/deployments/by-name/nonexistent',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/deployments/by-name/some-name',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /v1/registry/deployments/:id/rotate-token ──────────────────────────

describe('POST /v1/registry/deployments/:id/rotate-token', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 200 with new runtimeToken on success', async () => {
    mockProvisionInstance.rotateToken.mockResolvedValue({
      runtimeToken: 'new-rotated-token',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/deploy-001/rotate-token',
      headers: { authorization: `Bearer ${deployToken}` },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.runtimeToken).toBe('new-rotated-token');
    expect(mockProvisionInstance.rotateToken).toHaveBeenCalledWith(
      'deploy-001',
      TENANT_ID,
      expect.anything(),
    );
  });

  it('returns 404 when deployment is not found or not READY', async () => {
    mockProvisionInstance.rotateToken.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/nonexistent/rotate-token',
      headers: { authorization: `Bearer ${deployToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/deploy-001/rotate-token',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when token lacks deploy:write scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/deployments/deploy-001/rotate-token',
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── orgSlug validation ──────────────────────────────────────────────────────

describe('orgSlug validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns 401 when JWT has null orgSlug', async () => {
    const nullSlugToken = signJwt(
      { sub: 'user-1', tenantId: TENANT_ID, orgSlug: null, scopes: ['artifact:read'] },
      REGISTRY_SECRET,
      86_400_000,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${nullSlugToken}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/orgSlug/);
  });

  it('returns 401 when JWT has no orgSlug field', async () => {
    const noSlugToken = signJwt(
      { sub: 'user-1', tenantId: TENANT_ID, scopes: ['artifact:read'] },
      REGISTRY_SECRET,
      86_400_000,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/list',
      headers: { authorization: `Bearer ${noSlugToken}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/orgSlug/);
  });

  it('returns 403 when JWT orgSlug does not match tenant in DB', async () => {
    const mismatchToken = signJwt(
      { sub: 'user-1', tenantId: TENANT_ID, orgSlug: 'wrong-slug', scopes: ['registry:push'] },
      REGISTRY_SECRET,
      86_400_000,
    );

    const form = new FormData();
    form.append('bundle', new Blob([Buffer.from('fake')]), 'test.orb');
    form.append('name', 'test');
    form.append('kind', 'Agent');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/push',
      headers: { authorization: `Bearer ${mismatchToken}` },
      payload: form,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/orgSlug/);
  });
});

// ── GET /v1/registry/embedding-providers ──────────────────────────────────

describe('GET /v1/registry/embedding-providers', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns provider list when system embedder is configured', async () => {
    mockEmbeddingInstance.resolveEmbedder.mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/embedding-providers',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0]).toEqual({
      name: 'system-embedder',
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });

  it('returns empty array when no embedder is configured', async () => {
    mockEmbeddingInstance.resolveEmbedder.mockRejectedValue(
      new Error('No embedding config available'),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/embedding-providers',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual([]);
  });

  it('returns 500 when resolveEmbedder throws an unexpected error', async () => {
    mockEmbeddingInstance.resolveEmbedder.mockRejectedValue(
      new Error('Connection refused'),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/embedding-providers',
      headers: { authorization: `Bearer ${readToken}` },
    });

    expect(res.statusCode).toBe(500);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/registry/embedding-providers' });
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /v1/registry/embeddings ──────────────────────────────────────────

describe('POST /v1/registry/embeddings', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => { await app.close(); });

  it('returns embeddings for given texts', async () => {
    mockEmbeddingInstance.resolveEmbedder.mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      apiKey: 'sk-test',
    });
    mockEmbeddingInstance.embedTexts.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${readToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ texts: ['chunk 1', 'chunk 2'] }),
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.embeddings).toHaveLength(2);
    expect(json.model).toBe('text-embedding-3-small');
    expect(json.dimensions).toBe(1536);
    expect(mockEmbeddingInstance.embedTexts).toHaveBeenCalledWith(
      ['chunk 1', 'chunk 2'],
      expect.objectContaining({ provider: 'openai', model: 'text-embedding-3-small' }),
    );
  });

  it('returns 400 when texts array is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${readToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ texts: [] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty array/i);
  });

  it('returns 400 when texts field is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${readToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty array/i);
  });

  it('returns 400 when texts contains a non-string element', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${readToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ texts: ['hello', 42] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/texts\[1\] is not a string/);
  });

  it('returns 400 when texts contains only whitespace strings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${readToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ texts: ['  ', '\t', ''] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty string/i);
  });

  it('returns 401 when authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ texts: ['hello'] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects deploy:write scope for embedding-providers', async () => {
    mockEmbeddingInstance.resolveEmbedder.mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    mockEmbeddingInstance.embedTexts.mockResolvedValue({
      embeddings: [[0.1, 0.2]],
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });

    // Note: artifact:read is currently the required scope; deploy:write tokens
    // do not have artifact:read, so they get 403 unless the route allows both.
    // The current implementation uses artifact:read scope.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/embeddings',
      headers: {
        authorization: `Bearer ${deployToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ texts: ['hello'] }),
    });

    // deploy:write token lacks artifact:read scope, so 403 is expected
    expect(res.statusCode).toBe(403);
  });
});
