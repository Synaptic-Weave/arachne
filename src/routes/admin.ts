import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import { adminAuthMiddleware } from '../middleware/adminAuth.js';
import { invalidateCachedKey, invalidateAllKeysForTenant } from '../auth.js';
import { evictProvider } from '../providers/registry.js';
import { encryptTraceBody, decryptTraceBody } from '../encryption.js';
import { getAdminAnalyticsSummary, getAdminTimeseriesMetrics, getAdminModelBreakdown } from '../analytics.js';
import { AdminService } from '../application/services/AdminService.js';
import { ProviderManagementService } from '../application/services/ProviderManagementService.js';
import { signJwt } from '../auth/jwtUtils.js';
import type { CreateProviderDto, UpdateProviderDto } from '../application/dtos/provider.dto.js';
import { SmokeTestRun } from '../domain/entities/SmokeTestRun.js';
import { orm } from '../orm.js';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'unsafe-dev-secret-change-in-production';

interface LoginBody {
  username: string;
  password: string;
}

/**
 * Register admin routes
 * All routes except /v1/admin/auth/login require JWT authentication
 */
export function registerAdminRoutes(fastify: FastifyInstance, adminService: AdminService, em: EntityManager): void {

  // POST /v1/admin/auth/login — Admin login endpoint
  fastify.post<{ Body: LoginBody }>(
    '/v1/admin/auth/login',
    async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
      const { username, password } = request.body;

      if (!username || !password) {
        return reply.code(400).send({ error: 'Username and password required' });
      }

      let adminUser: { id: string; username: string; mustChangePassword: boolean } | null;
      try {
        adminUser = await adminService.validateAdminLogin(username, password);
      } catch (err) {
        fastify.log.error({ err }, 'Password verification failed');
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      if (!adminUser) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Update last_login timestamp
      await adminService.updateAdminLastLogin(adminUser.id);

      // Issue JWT (8 hour expiry)
      const token = signJwt(
        { sub: adminUser.id, username: adminUser.username },
        ADMIN_JWT_SECRET,
        8 * 60 * 60 * 1000
      );

      return reply.send({ token, username: adminUser.username, mustChangePassword: adminUser.mustChangePassword });
    }
  );

  // POST /v1/admin/auth/change-password — Change admin password
  fastify.post<{ Body: { currentPassword?: string; newPassword: string } }>(
    '/v1/admin/auth/change-password',
    { preHandler: adminAuthMiddleware },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body;

      if (!newPassword || newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const adminId = request.adminUser?.sub;
      if (!adminId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      if (currentPassword) {
        const result = await adminService.changeAdminPassword(adminId, currentPassword, newPassword);
        if (!result.success) {
          if (result.error === 'invalid_current_password') {
            return reply.code(400).send({ error: 'Current password is incorrect' });
          }
          return reply.code(500).send({ error: 'Failed to change password' });
        }
      } else {
        await adminService.forceChangeAdminPassword(adminId, newPassword);
      }

      return reply.send({ message: 'Password changed successfully' });
    }
  );

  // Tenant CRUD stubs — all require admin auth
  const authOpts = { preHandler: adminAuthMiddleware };

  // POST /v1/admin/tenants — Create tenant
  fastify.post<{ Body: { name: string } }>(
    '/v1/admin/tenants',
    authOpts,
    async (request, reply) => {
      const { name } = request.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'Tenant name is required' });
      }

      const tenant = await adminService.createTenant(name.trim());
      return reply.code(201).send(tenant);
    }
  );

  // GET /v1/admin/tenants — List tenants
  fastify.get<{
    Querystring: { limit?: string; offset?: string; status?: string };
  }>('/v1/admin/tenants', authOpts, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);
    const { status } = request.query;

    const result = await adminService.listTenants({ limit, offset, status });
    return reply.send(result);
  });

  // GET /v1/admin/tenants/:id — Get tenant details
  fastify.get<{ Params: { id: string } }>(
    '/v1/admin/tenants/:id',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;

      const tenant = await adminService.getTenant(id);

      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      // Build provider config summary
      let providerConfigSummary = null;
      if (tenant.provider_config) {
        const cfg = tenant.provider_config;
        providerConfigSummary = {
          provider: cfg.provider,
          baseUrl: cfg.baseUrl,
          deployment: cfg.deployment,
          apiVersion: cfg.apiVersion,
          hasApiKey: !!(cfg.apiKey),
        };
      }

      return reply.send({
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        providerConfig: providerConfigSummary,
        apiKeyCount: parseInt(tenant.api_key_count, 10),
        createdAt: tenant.created_at,
        updatedAt: tenant.updated_at,
      });
    }
  );

  // PATCH /v1/admin/tenants/:id — Update tenant
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; status?: string };
  }>('/v1/admin/tenants/:id', authOpts, async (request, reply) => {
    const { id } = request.params;
    const { name, status } = request.body;

    if (!name && !status) {
      return reply.code(400).send({ error: 'At least one field (name or status) is required' });
    }

    if (status && status !== 'active' && status !== 'inactive') {
      return reply.code(400).send({ error: 'Status must be "active" or "inactive"' });
    }

    const updated = await adminService.updateTenant(id, { name, status });

    if (!updated) {
      return reply.code(404).send({ error: 'Tenant not found' });
    }

    // If status changed to inactive, invalidate cache and evict provider
    if (status === 'inactive') {
      await invalidateAllKeysForTenant(id, em);
      evictProvider(id);
    }

    return reply.send(updated);
  });

  // DELETE /v1/admin/tenants/:id — Hard delete tenant
  fastify.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/v1/admin/tenants/:id',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;
      const { confirm } = request.query;

      if (confirm !== 'true') {
        return reply.code(400).send({ error: 'Must include ?confirm=true to delete tenant' });
      }

      // Invalidate cache and evict provider before deletion
      await invalidateAllKeysForTenant(id, em);
      evictProvider(id);

      const deleted = await adminService.deleteTenant(id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      return reply.code(204).send();
    }
  );

  // PUT /v1/admin/tenants/:id/provider-config — Set/replace provider config
  fastify.put<{
    Params: { id: string };
    Body: {
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      deployment?: string;
      apiVersion?: string;
    };
  }>('/v1/admin/tenants/:id/provider-config', authOpts, async (request, reply) => {
    const { id } = request.params;
    const { provider, apiKey, baseUrl, deployment, apiVersion } = request.body;

    if (!provider || (provider !== 'openai' && provider !== 'azure')) {
      return reply.code(400).send({ error: 'Provider must be "openai" or "azure"' });
    }

    // Verify tenant exists
    const exists = await adminService.tenantExists(id);
    if (!exists) {
      return reply.code(404).send({ error: 'Tenant not found' });
    }

    // Build provider config object
    const providerConfig: any = { provider };

    if (baseUrl) providerConfig.baseUrl = baseUrl;
    if (deployment) providerConfig.deployment = deployment;
    if (apiVersion) providerConfig.apiVersion = apiVersion;

    // Encrypt API key if provided
    if (apiKey) {
      try {
        const encrypted = encryptTraceBody(id, apiKey);
        providerConfig.apiKey = `encrypted:${encrypted.ciphertext}:${encrypted.iv}`;
      } catch (err) {
        fastify.log.error({ err }, 'Failed to encrypt provider API key');
        return reply.code(500).send({ error: 'Failed to encrypt API key' });
      }
    }

    await adminService.setProviderConfig(id, providerConfig);

    // Evict provider cache
    evictProvider(id);

    // Return sanitized response
    return reply.send({
      providerConfig: {
        provider,
        baseUrl,
        deployment,
        apiVersion,
        hasApiKey: !!apiKey,
      },
    });
  });

  // DELETE /v1/admin/tenants/:id/provider-config — Remove provider config
  fastify.delete<{ Params: { id: string } }>(
    '/v1/admin/tenants/:id/provider-config',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;

      const found = await adminService.clearProviderConfig(id);

      if (!found) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      evictProvider(id);

      return reply.code(204).send();
    }
  );

  // POST /v1/admin/tenants/:id/api-keys — Create API key
  fastify.post<{ Params: { id: string }; Body: { name: string } }>(
    '/v1/admin/tenants/:id/api-keys',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;
      const { name } = request.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'API key name is required' });
      }

      // Verify tenant exists
      const exists = await adminService.tenantExists(id);
      if (!exists) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      // Generate raw key
      const rawKey = 'loom_sk_' + randomBytes(24).toString('base64url');
      const keyPrefix = rawKey.slice(0, 12);
      const keyHash = createHash('sha256').update(rawKey).digest('hex');

      const row = await adminService.createApiKey(id, name.trim(), rawKey, keyPrefix, keyHash);

      return reply.code(201).send({
        id: row.id,
        name: row.name,
        key: rawKey,
        keyPrefix: row.key_prefix,
        status: row.status,
        createdAt: row.created_at,
      });
    }
  );

  // GET /v1/admin/tenants/:id/api-keys — List API keys
  fastify.get<{ Params: { id: string } }>(
    '/v1/admin/tenants/:id/api-keys',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;

      const rows = await adminService.listApiKeys(id);

      return reply.send({
        apiKeys: rows.map((row) => ({
          id: row.id,
          name: row.name,
          keyPrefix: row.key_prefix,
          status: row.status,
          createdAt: row.created_at,
          revokedAt: row.revoked_at,
        })),
      });
    }
  );

  // DELETE /v1/admin/tenants/:id/api-keys/:keyId — Revoke or hard delete API key
  fastify.delete<{
    Params: { id: string; keyId: string };
    Querystring: { permanent?: string };
  }>('/v1/admin/tenants/:id/api-keys/:keyId', authOpts, async (request, reply) => {
    const { id, keyId } = request.params;
    const { permanent } = request.query;

    if (permanent === 'true') {
      // Hard delete — get key_hash first for cache invalidation
      const keyHash = await adminService.getApiKeyHash(keyId, id);

      if (keyHash === null) {
        return reply.code(404).send({ error: 'API key not found' });
      }

      // Invalidate cache
      invalidateCachedKey(keyHash);

      await adminService.hardDeleteApiKey(keyId, id);
    } else {
      // Soft revoke
      const keyHash = await adminService.revokeApiKey(keyId, id);

      if (keyHash === null) {
        return reply.code(404).send({ error: 'API key not found' });
      }

      // Invalidate cache
      invalidateCachedKey(keyHash);
    }

    return reply.code(204).send();
  });

  // GET /v1/admin/traces — Paginated traces across all tenants
  fastify.get<{
    Querystring: { tenant_id?: string; limit?: string; cursor?: string };
  }>('/v1/admin/traces', authOpts, async (request, reply) => {
    const { tenant_id, cursor } = request.query;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);

    const traces = await adminService.listTraces({ limit, tenant_id, cursor });
    const nextCursor =
      traces.length === limit
        ? (traces[traces.length - 1].created_at as Date).toISOString()
        : null;

    return reply.send({ traces, nextCursor });
  });

  // GET /v1/admin/analytics/summary — Aggregated metrics across all tenants
  fastify.get<{
    Querystring: { tenant_id?: string; window?: string };
  }>('/v1/admin/analytics/summary', authOpts, async (request, reply) => {
    const { tenant_id } = request.query;
    const windowHours = parseInt(request.query.window ?? '24', 10);

    const summary = await getAdminAnalyticsSummary(tenant_id, windowHours);
    return reply.send(summary);
  });

  // GET /v1/admin/analytics/timeseries — Time-bucketed metrics across all tenants
  fastify.get<{
    Querystring: { tenant_id?: string; window?: string; bucket?: string };
  }>('/v1/admin/analytics/timeseries', authOpts, async (request, reply) => {
    const { tenant_id } = request.query;
    const windowHours = parseInt(request.query.window ?? '24', 10);
    const bucketMinutes = parseInt(request.query.bucket ?? '60', 10);

    const timeseries = await getAdminTimeseriesMetrics(tenant_id, windowHours, bucketMinutes);
    return reply.send(timeseries);
  });

  // GET /v1/admin/analytics/models — Per-model breakdown across all tenants
  fastify.get<{
    Querystring: { tenant_id?: string; window?: string };
  }>('/v1/admin/analytics/models', authOpts, async (request, reply) => {
    const { tenant_id } = request.query;
    const windowHours = parseInt(request.query.window ?? '24', 10);
    const models = await getAdminModelBreakdown(tenant_id, windowHours);
    return reply.send({ models });
  });

  // GET /v1/admin/beta/signups — List all beta signups
  fastify.get('/v1/admin/beta/signups', authOpts, async (request, reply) => {
    const signups = await adminService.listBetaSignups();
    return reply.send({ signups });
  });

  // POST /v1/admin/beta/approve/:id — Approve a beta signup and generate invite code
  fastify.post<{ Params: { id: string } }>(
    '/v1/admin/beta/approve/:id',
    authOpts,
    async (request, reply) => {
      const { id } = request.params;
      const adminId = request.adminUser?.sub;

      if (!adminId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const signup = await adminService.approveBetaSignup(id, adminId);

      if (!signup) {
        return reply.code(404).send({ error: 'Beta signup not found' });
      }

      return reply.send(signup);
    }
  );

  // GET /v1/admin/settings — Get current settings
  fastify.get('/v1/admin/settings', authOpts, async (request, reply) => {
    const settings = await adminService.getSettings();
    return reply.send(settings);
  });

  // PUT /v1/admin/settings — Update settings
  fastify.put<{
    Body: {
      signupsEnabled?: boolean;
      defaultEmbedderProvider?: string | null;
      defaultEmbedderModel?: string | null;
      defaultEmbedderApiKey?: string | null;
      defaultEmbedderProviderId?: string | null;
    };
  }>(
    '/v1/admin/settings',
    authOpts,
    async (request, reply) => {
      const adminId = request.adminUser?.sub;

      if (!adminId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { signupsEnabled, defaultEmbedderProvider, defaultEmbedderModel, defaultEmbedderApiKey, defaultEmbedderProviderId } = request.body;

      if (signupsEnabled !== undefined && typeof signupsEnabled !== 'boolean') {
        return reply.code(400).send({ error: 'signupsEnabled must be a boolean' });
      }

      // Validate referenced provider exists
      if (defaultEmbedderProviderId !== undefined && defaultEmbedderProviderId !== null) {
        const providerSvc = new ProviderManagementService(em.fork());
        try {
          await providerSvc.getGatewayProvider(defaultEmbedderProviderId);
        } catch {
          return reply.code(400).send({ error: 'Referenced gateway provider does not exist' });
        }
      }

      const settings = await adminService.updateSettings(
        { signupsEnabled, defaultEmbedderProvider, defaultEmbedderModel, defaultEmbedderApiKey, defaultEmbedderProviderId },
        adminId,
      );
      return reply.send(settings);
    }
  );

  // ===== Provider Management Routes =====

  const providerService = new ProviderManagementService(em.fork());

  // GET /v1/admin/providers — List all gateway providers
  fastify.get('/v1/admin/providers', authOpts, async (request, reply) => {
    const providers = await providerService.listGatewayProviders();
    return reply.send(providers);
  });

  // GET /v1/admin/providers/:id — Get a gateway provider by ID
  fastify.get<{ Params: { id: string } }>(
    '/v1/admin/providers/:id',
    authOpts,
    async (request, reply) => {
      try {
        const provider = await providerService.getGatewayProvider(request.params.id);
        return reply.send(provider);
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        throw err;
      }
    }
  );

  // POST /v1/admin/providers — Create a gateway provider
  fastify.post<{ Body: CreateProviderDto }>(
    '/v1/admin/providers',
    authOpts,
    async (request, reply) => {
      try {
        const provider = await providerService.createGatewayProvider(request.body);
        return reply.code(201).send(provider);
      } catch (err: any) {
        if (err.status === 400) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  // PUT /v1/admin/providers/:id — Update a gateway provider
  fastify.put<{ Params: { id: string }; Body: UpdateProviderDto }>(
    '/v1/admin/providers/:id',
    authOpts,
    async (request, reply) => {
      try {
        const provider = await providerService.updateGatewayProvider(
          request.params.id,
          request.body
        );
        return reply.send(provider);
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        if (err.status === 400) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  // DELETE /v1/admin/providers/:id — Delete a gateway provider
  fastify.delete<{ Params: { id: string } }>(
    '/v1/admin/providers/:id',
    authOpts,
    async (request, reply) => {
      try {
        await providerService.deleteGatewayProvider(request.params.id);
        return reply.code(204).send();
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        if (err.status === 400) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  // POST /v1/admin/providers/:id/default — Set a gateway provider as default
  fastify.post<{ Params: { id: string } }>(
    '/v1/admin/providers/:id/default',
    authOpts,
    async (request, reply) => {
      try {
        const provider = await providerService.setGatewayDefault(request.params.id);
        return reply.send(provider);
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        throw err;
      }
    }
  );

  // ===== Provider Tenant Availability Routes =====

  // PUT /v1/admin/providers/:id/availability — Toggle tenant availability
  fastify.put<{ Params: { id: string }; Body: { tenantAvailable: boolean } }>(
    '/v1/admin/providers/:id/availability',
    authOpts,
    async (request, reply) => {
      try {
        const provider = await providerService.updateTenantAvailability(
          request.params.id,
          request.body.tenantAvailable,
        );
        return reply.send(provider);
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        throw err;
      }
    }
  );

  // GET /v1/admin/providers/:id/tenants — List tenants with access
  fastify.get<{ Params: { id: string } }>(
    '/v1/admin/providers/:id/tenants',
    authOpts,
    async (request, reply) => {
      try {
        const tenants = await providerService.listProviderTenantAccess(request.params.id);
        return reply.send({ tenants });
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        throw err;
      }
    }
  );

  // POST /v1/admin/providers/:id/tenants — Grant tenant access
  fastify.post<{ Params: { id: string }; Body: { tenantId: string } }>(
    '/v1/admin/providers/:id/tenants',
    authOpts,
    async (request, reply) => {
      try {
        await providerService.grantTenantAccess(request.params.id, request.body.tenantId);
        return reply.code(201).send({ message: 'Access granted' });
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Provider or tenant not found' });
        }
        if (err.status === 400) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  // DELETE /v1/admin/providers/:id/tenants/:tenantId — Revoke tenant access
  fastify.delete<{ Params: { id: string; tenantId: string } }>(
    '/v1/admin/providers/:id/tenants/:tenantId',
    authOpts,
    async (request, reply) => {
      try {
        await providerService.revokeTenantAccess(request.params.id, request.params.tenantId);
        return reply.code(204).send();
      } catch (err: any) {
        if (err.name === 'NotFoundError') {
          return reply.code(404).send({ error: 'Access record not found' });
        }
        throw err;
      }
    }
  );

  // ===== Smoke Test Routes =====

  const SMOKE_RUNNER_URL = process.env.SMOKE_RUNNER_URL ?? 'http://localhost:3001';

  // GET /v1/admin/smoke-tests — List recent smoke test runs
  fastify.get<{
    Querystring: { limit?: string };
  }>('/v1/admin/smoke-tests', authOpts, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
    const smokeEm = orm.em.fork();
    const runs = await smokeEm.find(
      SmokeTestRun,
      {},
      { orderBy: { startedAt: 'DESC' }, limit }
    );
    return reply.send({ runs });
  });

  // GET /v1/admin/smoke-tests/:id — Get single smoke test run details
  fastify.get<{ Params: { id: string } }>(
    '/v1/admin/smoke-tests/:id',
    authOpts,
    async (request, reply) => {
      const smokeEm = orm.em.fork();
      const run = await smokeEm.findOne(SmokeTestRun, { id: request.params.id });
      if (!run) {
        return reply.code(404).send({ error: 'Smoke test run not found' });
      }
      return reply.send(run);
    }
  );

  // POST /v1/admin/smoke-tests/run — Trigger a new smoke test run
  fastify.post('/v1/admin/smoke-tests/run', authOpts, async (request, reply) => {
    try {
      const resp = await fetch(`${SMOKE_RUNNER_URL}/run`, { method: 'POST' });
      const data = await resp.json() as { runId?: string; error?: string };

      if (!resp.ok) {
        return reply.code(resp.status).send(data);
      }

      return reply.code(202).send({ runId: data.runId, status: 'running' });
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to reach smoke runner');
      return reply.code(502).send({ error: 'Smoke runner is not reachable' });
    }
  });
}

