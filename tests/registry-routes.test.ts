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

const { mockRegistryInstance, mockProvisionInstance } = vi.hoisted(() => {
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
  };
  return { mockRegistryInstance, mockProvisionInstance };
});

vi.mock('../src/services/RegistryService.js', () => ({
  RegistryService: vi.fn(() => mockRegistryInstance),
}));

vi.mock('../src/services/ProvisionService.js', () => ({
  ProvisionService: vi.fn(() => mockProvisionInstance),
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
    request.em = {} as any;
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
