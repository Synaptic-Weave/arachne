/**
 * H4: Multi-Tenant Isolation Tests (issue #14)
 *
 * Validates that tenants are strictly isolated:
 * - Each API key resolves to the correct tenant only
 * - Cross-tenant data access is not possible via mismatched keys
 * - Separate per-tenant encryption keys produce distinct ciphertext
 * - Auth errors return appropriate HTTP status codes
 * - Concurrent requests from multiple tenants don't bleed TenantContext
 *
 * Uses src/auth.ts registerAuthMiddleware with a mocked pg.Pool (no DB required).
 * Uses src/encryption.ts encryptTraceBody directly for key-isolation assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { EntityManager } from '@mikro-orm/core';
import { registerAuthMiddleware } from '../src/auth.js';
import { encryptTraceBody } from '../src/encryption.js';

// ── Constants ──────────────────────────────────────────────────────────────

const TEST_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Two distinct tenants used across all tests
const TENANT_A = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: 'Tenant Alpha',
  apiKey: 'sk-alpha-secret-key-xxxxxxxxxxxx',
};
const TENANT_B = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  name: 'Tenant Beta',
  apiKey: 'sk-beta-secret-key-yyyyyyyyyyyy',
};

// Pre-computed SHA-256 hashes (what auth middleware stores/looks up)
const HASH_A = sha256(TENANT_A.apiKey);
const HASH_B = sha256(TENANT_B.apiKey);

// ── Mock pool factory ──────────────────────────────────────────────────────

/**
 * Returns a fake EntityManager whose findOne() resolves based on the key hash.
 * Simulates the ApiKey lookup that TenantService.loadByApiKey performs.
 */
function buildMockEm(options: { inactiveTenantHash?: string } = {}): EntityManager {
  const findOne = vi.fn().mockImplementation(async (_Entity: any, where: any, _opts?: any) => {
    const keyHash = where?.keyHash as string;
    if (keyHash === HASH_A) {
      return {
        keyHash: HASH_A,
        status: 'active',
        agent: null,
        tenant: { id: TENANT_A.id, name: TENANT_A.name, status: 'active', parentId: null, providerConfig: null, systemPrompt: null, skills: null, mcpEndpoints: null, availableModels: null },
      };
    }
    if (keyHash === HASH_B) {
      return {
        keyHash: HASH_B,
        status: 'active',
        agent: null,
        tenant: { id: TENANT_B.id, name: TENANT_B.name, status: 'active', parentId: null, providerConfig: null, systemPrompt: null, skills: null, mcpEndpoints: null, availableModels: null },
      };
    }
    if (options.inactiveTenantHash && keyHash === options.inactiveTenantHash) {
      // Return null to simulate inactive/deleted tenant key not found
      return null;
    }
    return null;
  });
  return { findOne, find: vi.fn().mockResolvedValue([]) } as unknown as EntityManager;
}

/**
 * Build a minimal Fastify app with auth middleware and an echo endpoint
 * that returns the resolved tenant context.
 */
async function buildApp(em: EntityManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Per-request EM forking (simulated for tests)
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = em;
  });
  registerAuthMiddleware(app);

  app.post('/v1/chat/completions', async (req) => {
    return { tenant: req.tenant };
  });

  await app.ready();
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('H4: Multi-Tenant Isolation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    app = await buildApp(buildMockEm());
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  // ── API key → tenant scoping ─────────────────────────────────────────────

  it("Tenant A's API key resolves to Tenant A's context", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TENANT_A.apiKey}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenant: { tenantId: string } }>();
    expect(body.tenant.tenantId).toBe(TENANT_A.id);
  });

  it("Tenant B's API key resolves to Tenant B's context", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TENANT_B.apiKey}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ tenant: { tenantId: string } }>();
    expect(body.tenant.tenantId).toBe(TENANT_B.id);
  });

  it("Tenant A's API key cannot access Tenant B's tenant_id", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TENANT_A.apiKey}` },
      payload: {},
    });

    const body = res.json<{ tenant: { tenantId: string } }>();
    expect(body.tenant.tenantId).not.toBe(TENANT_B.id);
  });

  // ── Missing / invalid keys ───────────────────────────────────────────────

  it('missing API key returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {},
    });

    expect(res.statusCode).toBe(401);
  });

  it('invalid API key returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-completely-wrong-key' },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('deleted/inactive tenant API key returns 401 (DB query returns no rows)', async () => {
    // Inactive tenants have their API keys filtered out at the DB level.
    // The middleware sees 0 rows and returns 401.
    // TODO: differentiate 401 vs 403 once the auth middleware inspects tenant.active flag.
    const inactiveKey = 'sk-inactive-tenant-key-zzzzzzzzz';
    const inactiveHash = sha256(inactiveKey);
    const appWithInactive = await buildApp(buildMockEm({ inactiveTenantHash: inactiveHash }));

    const res = await appWithInactive.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': inactiveKey },
      payload: {},
    });

    await appWithInactive.close();
    expect(res.statusCode).toBe(401);
  });

  // ── Encryption key isolation ─────────────────────────────────────────────

  it('two tenants using the same model produce different ciphertext for identical content', () => {
    const plaintext = JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello world' }],
    });

    const { ciphertext: ctA } = encryptTraceBody(TENANT_A.id, plaintext);
    const { ciphertext: ctB } = encryptTraceBody(TENANT_B.id, plaintext);

    // Different per-tenant keys → different ciphertext even for identical plaintext
    expect(ctA).not.toBe(ctB);
  });

  // ── Race condition / concurrent requests ─────────────────────────────────

  it('concurrent requests from two tenants are scoped to their own TenantContext', async () => {
    // Fire 10 pairs of concurrent requests interleaved
    const concurrencyPairs = Array.from({ length: 10 }, (_, i) =>
      Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: `Bearer ${TENANT_A.apiKey}` },
          payload: { request: i },
        }),
        app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: `Bearer ${TENANT_B.apiKey}` },
          payload: { request: i },
        }),
      ])
    );

    const results = await Promise.all(concurrencyPairs);

    for (const [resA, resB] of results) {
      const bodyA = resA.json<{ tenant: { tenantId: string } }>();
      const bodyB = resB.json<{ tenant: { tenantId: string } }>();

      // Each request must be scoped to its own tenant — no cross-contamination
      expect(bodyA.tenant.tenantId).toBe(TENANT_A.id);
      expect(bodyB.tenant.tenantId).toBe(TENANT_B.id);
      expect(bodyA.tenant.tenantId).not.toBe(bodyB.tenant.tenantId);
    }
  });
});
