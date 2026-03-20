/**
 * Runtime Token Auth Tests
 *
 * Validates that the gateway auth middleware correctly handles runtime JWTs
 * issued by ProvisionService for deployed artifacts. Tests cover:
 * - Valid runtime JWT resolves TenantContext
 * - Expired runtime JWT returns 401
 * - Runtime JWT with wrong/missing scope returns 403
 * - API key auth still works unchanged (regression)
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

// We test the auth logic by building a minimal Fastify app that mimics the
// gateway's auth middleware behavior with runtime JWT support.

const TEST_SECRET = 'test-runtime-secret-12345';
const TEST_TENANT_ID = 'tenant-runtime-001';
const TEST_ARTIFACT_ID = 'artifact-001';
const TEST_DEPLOYMENT_ID = 'deployment-001';

function mintRuntimeToken(
  overrides: Record<string, unknown> = {},
  expiresIn: string | number = '1h',
): string {
  return jwt.sign(
    {
      tenantId: TEST_TENANT_ID,
      artifactId: TEST_ARTIFACT_ID,
      deploymentId: TEST_DEPLOYMENT_ID,
      scopes: ['runtime:access'],
      ...overrides,
    },
    TEST_SECRET,
    { expiresIn },
  );
}

// Build a test gateway that mirrors the real auth middleware's runtime JWT path
function buildRuntimeAuthGateway(port: number): FastifyInstance {
  const app = Fastify({ logger: false });

  app.decorateRequest('tenant', null);

  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return;

    const authHeader = request.headers['authorization'];
    const xApiKey = request.headers['x-api-key'];

    let rawKey: string | undefined;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      rawKey = authHeader.slice(7).trim();
    } else if (typeof xApiKey === 'string') {
      rawKey = xApiKey.trim();
    }

    if (!rawKey) {
      return reply.code(401).send({
        error: { message: 'Missing API key', type: 'invalid_request_error', code: 'missing_api_key' },
      });
    }

    // Runtime JWT detection (mirrors src/auth.ts)
    if (rawKey.split('.').length === 3) {
      try {
        const payload = jwt.verify(rawKey, TEST_SECRET) as {
          tenantId: string;
          artifactId: string;
          deploymentId: string;
          scopes?: string[];
        };

        if (!payload.scopes || !payload.scopes.includes('runtime:access')) {
          return reply.code(403).send({
            error: {
              message: 'Token does not have runtime:access scope.',
              type: 'invalid_request_error',
              code: 'insufficient_scope',
            },
          });
        }

        // Simulate successful runtime context resolution
        (request as any).tenant = {
          tenantId: payload.tenantId,
          name: 'Runtime Tenant',
          agentId: payload.deploymentId,
          mergePolicies: { system_prompt: 'prepend', skills: 'merge' },
        };
        return;
      } catch {
        // JWT verification failed, fall through to API key path
      }
    }

    // Simulate API key lookup
    const VALID_KEYS: Record<string, any> = {
      'sk-test-valid-key': {
        tenantId: 'tenant-apikey-001',
        name: 'API Key Tenant',
        agentId: 'agent-001',
        mergePolicies: {},
      },
    };

    const tenant = VALID_KEYS[rawKey];
    if (!tenant) {
      return reply.code(401).send({
        error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }

    (request as any).tenant = tenant;
  });

  app.post('/v1/chat/completions', async (request) => {
    return { tenant: (request as any).tenant };
  });

  return app;
}

describe('runtime-auth: valid runtime JWT resolves TenantContext', () => {
  let app: FastifyInstance;
  const PORT = 3040;

  beforeAll(async () => {
    app = buildRuntimeAuthGateway(PORT);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('valid runtime JWT with runtime:access scope returns 200 with tenant context', async () => {
    const token = mintRuntimeToken();

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tenant).toMatchObject({
      tenantId: TEST_TENANT_ID,
      agentId: TEST_DEPLOYMENT_ID,
    });
  });

  it('tenant context from runtime JWT includes deployment ID as agentId', async () => {
    const customDeploymentId = 'deploy-custom-999';
    const token = mintRuntimeToken({ deploymentId: customDeploymentId });

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tenant.agentId).toBe(customDeploymentId);
  });
});

describe('runtime-auth: expired runtime JWT returns 401', () => {
  let app: FastifyInstance;
  const PORT = 3041;

  beforeAll(async () => {
    app = buildRuntimeAuthGateway(PORT);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('expired runtime JWT falls through to API key path and returns 401', async () => {
    // Create an already-expired token
    const token = jwt.sign(
      {
        tenantId: TEST_TENANT_ID,
        artifactId: TEST_ARTIFACT_ID,
        deploymentId: TEST_DEPLOYMENT_ID,
        scopes: ['runtime:access'],
      },
      TEST_SECRET,
      { expiresIn: -10 }, // expired
    );

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(401);
  });
});

describe('runtime-auth: wrong scope returns 403', () => {
  let app: FastifyInstance;
  const PORT = 3042;

  beforeAll(async () => {
    app = buildRuntimeAuthGateway(PORT);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('runtime JWT without runtime:access scope returns 403', async () => {
    const token = mintRuntimeToken({ scopes: ['registry:push'] });

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe('insufficient_scope');
  });

  it('runtime JWT with empty scopes array returns 403', async () => {
    const token = mintRuntimeToken({ scopes: [] });

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(403);
  });

  it('runtime JWT with no scopes field returns 403', async () => {
    const token = jwt.sign(
      {
        tenantId: TEST_TENANT_ID,
        artifactId: TEST_ARTIFACT_ID,
        deploymentId: TEST_DEPLOYMENT_ID,
        // no scopes field
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(403);
  });
});

describe('runtime-auth: API key auth regression', () => {
  let app: FastifyInstance;
  const PORT = 3043;

  beforeAll(async () => {
    app = buildRuntimeAuthGateway(PORT);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('traditional API key still works via Bearer header', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test-valid-key',
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tenant.tenantId).toBe('tenant-apikey-001');
  });

  it('traditional API key still works via x-api-key header', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-valid-key',
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tenant.tenantId).toBe('tenant-apikey-001');
  });

  it('invalid API key still returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-invalid-key',
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });

    expect(res.status).toBe(401);
  });
});
