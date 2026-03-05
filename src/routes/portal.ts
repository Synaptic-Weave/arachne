import { FastifyInstance } from 'fastify';
import { registerPortalAuthMiddleware } from '../middleware/portalAuth.js';
import { invalidateCachedKey } from '../auth.js';
import type { TenantContext } from '../auth.js';
import { encryptTraceBody, decryptTraceBody } from '../encryption.js';
import { traceRecorder } from '../tracing.js';
import { evictProvider, getProviderForTenant } from '../providers/registry.js';
import { applyAgentToRequest } from '../agent.js';
import { getAnalyticsSummary, getTimeseriesMetrics, getModelBreakdown } from '../analytics.js';
import { PortalService } from '../application/services/PortalService.js';
import { ConversationManagementService } from '../application/services/ConversationManagementService.js';
import { UserManagementService } from '../application/services/UserManagementService.js';
import { TenantManagementService } from '../application/services/TenantManagementService.js';
import { isSignupsEnabled } from '../config.js';
import { validateOrgSlug } from '../utils/slug.js';
import { RegistryService } from '../services/RegistryService.js';
import { ProvisionService } from '../services/ProvisionService.js';
import { orm } from '../orm.js';

export function registerPortalRoutes(
  fastify: FastifyInstance,
  svc: PortalService,
  conversationSvc: ConversationManagementService,
  userMgmtSvc: UserManagementService,
  tenantMgmtSvc: TenantManagementService
): void {
  const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL ?? 'http://localhost:3000';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function sanitizeAgentProviderConfig(cfg: Record<string, unknown> | null) {
    if (!cfg) return null;
    return {
      provider: cfg['provider'] ?? null,
      baseUrl: cfg['baseUrl'] ?? null,
      deployment: cfg['deployment'] ?? null,
      apiVersion: cfg['apiVersion'] ?? null,
      hasApiKey: !!(cfg['apiKey']),
    };
  }

  function prepareAgentProviderConfig(
    tenantId: string,
    rawConfig: Record<string, unknown> | undefined | null,
  ): Record<string, unknown> | null {
    if (!rawConfig) return null;
    const stored: Record<string, unknown> = { ...rawConfig };
    if (
      typeof stored['apiKey'] === 'string' &&
      stored['apiKey'] &&
      !String(stored['apiKey']).startsWith('encrypted:')
    ) {
      try {
        const encrypted = encryptTraceBody(tenantId, stored['apiKey'] as string);
        stored['apiKey'] = `encrypted:${encrypted.ciphertext}:${encrypted.iv}`;
      } catch {
        // if encryption fails, omit the key rather than store plaintext
        delete stored['apiKey'];
      }
    }
    return stored;
  }

  function formatAgent(row: {
    id: string; name: string;
    provider_config: Record<string, unknown> | null;
    system_prompt: string | null;
    skills: unknown[] | null;
    mcp_endpoints: unknown[] | null;
    merge_policies: Record<string, unknown>;
    available_models?: string[] | null;
    conversations_enabled?: boolean;
    conversation_token_limit?: number | null;
    conversation_summary_model?: string | null;
    created_at: string; updated_at: string | null;
  }) {
    return {
      id: row.id,
      name: row.name,
      providerConfig: sanitizeAgentProviderConfig(row.provider_config),
      systemPrompt: row.system_prompt,
      skills: row.skills,
      mcpEndpoints: row.mcp_endpoints,
      mergePolicies: row.merge_policies,
      availableModels: row.available_models ?? null,
      conversations_enabled: row.conversations_enabled ?? false,
      conversation_token_limit: row.conversation_token_limit ?? null,
      conversation_summary_model: row.conversation_summary_model ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── POST /v1/portal/auth/signup ───────────────────────────────────────────
  fastify.post<{
    Body: { tenantName?: string; email: string; password: string; inviteToken?: string };
  }>('/v1/portal/auth/signup', async (request, reply) => {
    const { tenantName, email, password, inviteToken } = request.body;

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Valid email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }

    if (inviteToken) {
      try {
        const result = await userMgmtSvc.acceptInvite({ email, password, inviteToken });
        return reply.code(201).send({
          token: result.token,
          user: { id: result.userId, email: result.email },
          tenant: { id: result.tenantId, name: result.tenantName },
        });
      } catch (err: any) {
        if (err.status === 409) return reply.code(409).send({ error: err.message });
        if (err.status === 400) return reply.code(400).send({ error: err.message });
        fastify.log.error({ err }, 'Invite signup failed');
        return reply.code(500).send({ error: 'Signup failed' });
      }
    } else {
      // Check if self-service signups are enabled
      if (!isSignupsEnabled()) {
        return reply.code(403).send({ error: 'Signups are currently disabled. Please contact support for an invite.' });
      }

      if (!tenantName || typeof tenantName !== 'string' || tenantName.trim().length === 0) {
        return reply.code(400).send({ error: 'tenantName is required' });
      }
      try {
        const result = await userMgmtSvc.createUser({ email, password, tenantName });
        return reply.code(201).send({
          token: result.token,
          user: { id: result.userId, email: result.email },
          tenant: { id: result.tenantId, name: result.tenantName },
        });
      } catch (err: any) {
        if (err.status === 409) return reply.code(409).send({ error: err.message });
        fastify.log.error({ err }, 'Signup transaction failed');
        return reply.code(500).send({ error: 'Signup failed' });
      }
    }
  });

  // ── POST /v1/portal/auth/login ────────────────────────────────────────────
  fastify.post<{
    Body: { email: string; password: string };
  }>('/v1/portal/auth/login', async (request, reply) => {
    const { email, password } = request.body;

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' });
    }

    try {
      const result = await userMgmtSvc.login({ email, password });
      return reply.send({
        token: result.token,
        user: { id: result.userId, email: result.email },
        tenant: { id: result.tenantId, name: result.tenantName },
        tenants: result.tenants,
      });
    } catch (err: any) {
      if (err.status === 403) return reply.code(403).send({ error: err.message });
      if (err.message === 'Invalid credentials') return reply.code(401).send({ error: 'Invalid credentials' });
      throw err;
    }
  });

  const authRequired = registerPortalAuthMiddleware(fastify);
  const ownerRequired = registerPortalAuthMiddleware(fastify, 'owner');

  // ── GET /v1/portal/me ─────────────────────────────────────────────────────
  fastify.get('/v1/portal/me', { preHandler: authRequired }, async (request, reply) => {
    const { userId, tenantId } = request.portalUser!;

    const data = await svc.getMe(userId, tenantId);
    if (!data) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const { row, tenants, agents, subtenants } = data;
    const cfg = row.provider_config;
    const providerConfig = cfg
      ? {
          provider: cfg['provider'],
          baseUrl: cfg['baseUrl'] ?? null,
          deployment: cfg['deployment'] ?? null,
          apiVersion: cfg['apiVersion'] ?? null,
          hasApiKey: !!(cfg['apiKey']),
        }
      : null;

    return reply.send({
      user: { id: row.id, email: row.email, role: row.role },
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        providerConfig,
        availableModels: row.available_models ?? null,
      },
      tenants: tenants.map((t) => ({ id: t.tenant_id, name: t.tenant_name, role: t.role })),
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      subtenants: subtenants.map((s) => ({ id: s.id, name: s.name, status: s.status })),
    });
  });

  // ── PATCH /v1/portal/settings ─────────────────────────────────────────────
  fastify.patch<{
    Body: {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      deployment?: string;
      apiVersion?: string;
      availableModels?: string[] | null;
      orgSlug?: string;
    };
  }>('/v1/portal/settings', { preHandler: ownerRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const { provider, apiKey, baseUrl, deployment, apiVersion, availableModels, orgSlug } = request.body;

    // Handle orgSlug update
    if (orgSlug !== undefined) {
      const validation = validateOrgSlug(orgSlug);
      if (!validation.valid) {
        return reply.code(400).send({ error: validation.error });
      }
      const existing = await tenantMgmtSvc.findByOrgSlug(orgSlug);
      if (existing && existing.id !== tenantId) {
        return reply.code(409).send({ error: 'This slug is already taken' });
      }
      await tenantMgmtSvc.updateSettings(tenantId, { orgSlug });
      if (!provider) {
        return reply.send({ orgSlug });
      }
    }

    if (!provider || (provider !== 'openai' && provider !== 'azure' && provider !== 'ollama')) {
      return reply.code(400).send({ error: 'Provider must be "openai" or "azure"' });
    }

    const providerConfig: Record<string, unknown> = { provider };
    if (baseUrl) providerConfig.baseUrl = baseUrl;
    if (deployment) providerConfig.deployment = deployment;
    if (apiVersion) providerConfig.apiVersion = apiVersion;

    if (apiKey) {
      try {
        const encrypted = encryptTraceBody(tenantId, apiKey);
        providerConfig.apiKey = `encrypted:${encrypted.ciphertext}:${encrypted.iv}`;
      } catch (err) {
        fastify.log.error({ err }, 'Failed to encrypt provider API key');
        return reply.code(500).send({
          error: 'Failed to encrypt API key. Ensure ENCRYPTION_MASTER_KEY is set.',
        });
      }
    }

    await tenantMgmtSvc.updateSettings(tenantId, {
      providerConfig,
      availableModels,
    });
    evictProvider(tenantId);

    return reply.send({
      providerConfig: {
        provider,
        baseUrl: baseUrl ?? null,
        deployment: deployment ?? null,
        apiVersion: apiVersion ?? null,
        hasApiKey: !!apiKey,
      },
      availableModels: availableModels !== undefined ? (availableModels ?? null) : undefined,
    });
  });

  // ── GET /v1/portal/api-keys ───────────────────────────────────────────────
  fastify.get('/v1/portal/api-keys', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const rows = await tenantMgmtSvc.listApiKeys(tenantId);
    return reply.send({
      apiKeys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        status: row.status,
        createdAt: row.createdAt,
        agentId: row.agentId,
        agentName: row.agentName,
      })),
    });
  });

  // ── POST /v1/portal/api-keys ──────────────────────────────────────────────
  fastify.post<{ Body: { name: string; agentId: string } }>(
    '/v1/portal/api-keys',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { name, agentId } = request.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'API key name is required' });
      }
      if (!agentId || typeof agentId !== 'string') {
        return reply.code(400).send({ error: 'agentId is required' });
      }

      const result = await tenantMgmtSvc.createApiKey(tenantId, agentId, { name });
      if (!result) {
        return reply.code(400).send({ error: 'Invalid agentId' });
      }

      return reply.code(201).send({
        id: result.id,
        name: result.name,
        key: result.rawKey,
        keyPrefix: result.keyPrefix,
        status: result.status,
        createdAt: result.createdAt,
      });
    },
  );

  // ── DELETE /v1/portal/api-keys/:id ───────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/api-keys/:id',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id: keyId } = request.params;

      try {
        const result = await tenantMgmtSvc.revokeApiKey(tenantId, keyId);
        invalidateCachedKey(result.keyHash);
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: 'API key not found' });
      }
    },
  );

  // ── GET /v1/portal/traces ─────────────────────────────────────────────────
  fastify.get('/v1/portal/traces', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const qs = request.query as Record<string, string>;
    const limit = Math.min(parseInt(qs.limit ?? '50', 10), 200);
    const cursor = qs.cursor;

    const traces = await svc.listTraces(tenantId, limit, cursor);
    const nextCursor =
      traces.length === limit
        ? (traces[traces.length - 1].created_at as Date).toISOString()
        : null;

    return reply.send({ traces, nextCursor });
  });

  // ── GET /v1/portal/analytics/summary ─────────────────────────────────────
  fastify.get('/v1/portal/analytics/summary', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const qs = request.query as Record<string, string>;
    const windowHours = parseInt(qs.window ?? '24', 10);
    const rollup = qs.rollup === 'true' || qs.rollup === '1';
    const summary = await getAnalyticsSummary(tenantId, windowHours, rollup);
    return reply.send(summary);
  });

  // ── GET /v1/portal/analytics/timeseries ──────────────────────────────────
  fastify.get('/v1/portal/analytics/timeseries', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const qs = request.query as Record<string, string>;
    const windowHours = parseInt(qs.window ?? '24', 10);
    const bucketMinutes = parseInt(qs.bucket ?? '60', 10);
    const rollup = qs.rollup === 'true' || qs.rollup === '1';
    const timeseries = await getTimeseriesMetrics(tenantId, windowHours, bucketMinutes, rollup);
    return reply.send(timeseries);
  });

  // ── GET /v1/portal/analytics/models ──────────────────────────────────────
  fastify.get('/v1/portal/analytics/models', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const qs = request.query as Record<string, string>;
    const windowHours = parseInt(qs.window ?? '24', 10);
    const rollup = qs.rollup === 'true' || qs.rollup === '1';
    const models = await getModelBreakdown(tenantId, windowHours, 10, rollup);
    return reply.send({ models });
  });

  // ── POST /v1/portal/auth/switch-tenant ────────────────────────────────────
  fastify.post<{ Body: { tenantId: string } }>(
    '/v1/portal/auth/switch-tenant',
    { preHandler: authRequired },
    async (request, reply) => {
      const { userId } = request.portalUser!;
      const { tenantId: newTenantId } = request.body;

      if (!newTenantId) {
        return reply.code(400).send({ error: 'tenantId is required' });
      }

      try {
        const result = await userMgmtSvc.switchTenant(userId, newTenantId);
        return reply.send({
          token: result.token,
          user: { id: result.userId, email: result.email },
          tenant: { id: result.tenantId, name: result.tenantName },
          tenants: (result.tenants ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            role: m.role,
          })),
        });
      } catch (err: any) {
        if (err.status === 403) return reply.code(403).send({ error: err.message });
        throw err;
      }
    },
  );

  // ── GET /v1/portal/invites/:token/info (public) ───────────────────────────
  fastify.get<{ Params: { token: string } }>(
    '/v1/portal/invites/:token/info',
    async (request, reply) => {
      const { token } = request.params;

      const row = await svc.getInviteInfo(token);
      if (!row) {
        return reply.code(404).send({ error: 'Invite not found' });
      }

      const now = new Date();
      const isValid =
        row.revoked_at === null &&
        new Date(row.expires_at) > now &&
        (row.max_uses === null || row.use_count < row.max_uses) &&
        row.tenant_status === 'active';

      return reply.send({
        tenantName: row.tenant_name,
        expiresAt: row.expires_at,
        isValid,
      });
    },
  );

  // ── POST /v1/portal/invites ───────────────────────────────────────────────
  fastify.post<{ Body: { maxUses?: number; expiresInHours?: number } }>(
    '/v1/portal/invites',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId, userId } = request.portalUser!;
      const { maxUses, expiresInHours = 168 } = request.body;

      const invite = await tenantMgmtSvc.inviteUser(tenantId, userId, {
        maxUses,
        expiresInDays: expiresInHours / 24,
      });
      return reply.code(201).send({
        id: invite.id,
        token: invite.token,
        inviteUrl: `${PORTAL_BASE_URL}/signup?invite=${invite.token}`,
        maxUses: invite.maxUses ?? null,
        useCount: invite.useCount,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      });
    },
  );

  // ── GET /v1/portal/invites ────────────────────────────────────────────────
  fastify.get('/v1/portal/invites', { preHandler: ownerRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const invites = await tenantMgmtSvc.listInvites(tenantId);
    const now = new Date();

    return reply.send({
      invites: invites.map((invite) => ({
        id: invite.id,
        token: invite.token,
        inviteUrl: `${PORTAL_BASE_URL}/signup?invite=${invite.token}`,
        maxUses: invite.maxUses ?? null,
        useCount: invite.useCount,
        expiresAt: invite.expiresAt,
        revokedAt: invite.revokedAt,
        createdAt: invite.createdAt,
        createdBy: null, // Domain service doesn't return creator info yet
        isActive:
          invite.revokedAt === null &&
          new Date(invite.expiresAt) > now &&
          (invite.maxUses === null || invite.useCount < invite.maxUses),
      })),
    });
  });

  // ── DELETE /v1/portal/invites/:id ─────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/invites/:id',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;

      try {
        await tenantMgmtSvc.revokeInvite(tenantId, id);
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: 'Invite not found or already revoked' });
      }
    },
  );

  // ── GET /v1/portal/members ────────────────────────────────────────────────
  fastify.get('/v1/portal/members', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const members = await tenantMgmtSvc.listMembers(tenantId);

    return reply.send({
      members: members.map((m) => ({
        id: m.userId,
        email: m.email,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    });
  });

  // ── PATCH /v1/portal/members/:userId ──────────────────────────────────────
  fastify.patch<{ Params: { userId: string }; Body: { role: 'owner' | 'member' } }>(
    '/v1/portal/members/:userId',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { userId: targetUserId } = request.params;
      const { role } = request.body;

      if (!role || (role !== 'owner' && role !== 'member')) {
        return reply.code(400).send({ error: 'Role must be "owner" or "member"' });
      }

      try {
        await tenantMgmtSvc.updateMemberRole(tenantId, targetUserId, role);
        // Re-fetch to get updated data for response
        const members = await tenantMgmtSvc.listMembers(tenantId);
        const updatedMember = members.find(m => m.userId === targetUserId);
        if (!updatedMember) {
          return reply.code(404).send({ error: 'Member not found' });
        }
        return reply.send({
          id: updatedMember.userId,
          email: updatedMember.email,
          role: updatedMember.role,
          joinedAt: updatedMember.joinedAt,
        });
      } catch (err: any) {
        if (err.status) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  // ── DELETE /v1/portal/members/:userId ─────────────────────────────────────
  fastify.delete<{ Params: { userId: string } }>(
    '/v1/portal/members/:userId',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId, userId: requestingUserId } = request.portalUser!;
      const { userId: targetUserId } = request.params;

      try {
        await tenantMgmtSvc.removeMember(tenantId, targetUserId, requestingUserId);
        return reply.code(204).send();
      } catch (err: any) {
        if (err.status) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  // ── GET /v1/portal/tenants ────────────────────────────────────────────────
  fastify.get('/v1/portal/tenants', { preHandler: authRequired }, async (request, reply) => {
    const { userId } = request.portalUser!;
    const rows = await svc.listUserTenants(userId);

    return reply.send({
      tenants: rows.map((row) => ({
        id: row.tenant_id,
        name: row.tenant_name,
        role: row.role,
        joinedAt: row.joined_at,
      })),
    });
  });

  // ── POST /v1/portal/tenants/:tenantId/leave ───────────────────────────────
  fastify.post<{ Params: { tenantId: string } }>(
    '/v1/portal/tenants/:tenantId/leave',
    { preHandler: authRequired },
    async (request, reply) => {
      const { userId, tenantId: currentTenantId } = request.portalUser!;
      const { tenantId: targetTenantId } = request.params;

      try {
        await userMgmtSvc.leaveTenant(userId, targetTenantId, currentTenantId);
        return reply.code(204).send();
      } catch (err: any) {
        if (err.status) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  // ── GET /v1/portal/subtenants ─────────────────────────────────────────────
  fastify.get('/v1/portal/subtenants', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const rows = await svc.listSubtenants(tenantId);

    return reply.send({
      subtenants: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
      })),
    });
  });

  // ── POST /v1/portal/subtenants ────────────────────────────────────────────
  fastify.post<{ Body: { name: string } }>(
    '/v1/portal/subtenants',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId, userId } = request.portalUser!;
      const { name } = request.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'name is required' });
      }

      try {
        const newTenant = await tenantMgmtSvc.createSubtenant(tenantId, {
          name,
          createdByUserId: userId,
        });
        return reply.code(201).send({
          subtenant: {
            id: newTenant.id,
            name: newTenant.name,
            parentId: null, // TenantViewModel doesn't include parentId
            status: newTenant.status,
            createdAt: newTenant.createdAt,
          },
        });
      } catch (err) {
        fastify.log.error({ err }, 'Create subtenant transaction failed');
        return reply.code(500).send({ error: 'Failed to create subtenant' });
      }
    },
  );

  // ── GET /v1/portal/agents ─────────────────────────────────────────────────
  fastify.get('/v1/portal/agents', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const rows = await svc.listAgents(tenantId);
    return reply.send({ agents: rows.map(formatAgent) });
  });

  // ── POST /v1/portal/agents ────────────────────────────────────────────────
  fastify.post<{
    Body: {
      name: string;
      providerConfig?: Record<string, unknown>;
      systemPrompt?: string;
      skills?: unknown[];
      mcpEndpoints?: unknown[];
      mergePolicies?: Record<string, unknown>;
    };
  }>('/v1/portal/agents', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const { name, providerConfig, systemPrompt, skills, mcpEndpoints, mergePolicies } = request.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'name is required' });
    }

    const storedProviderConfig = prepareAgentProviderConfig(tenantId, providerConfig ?? null);

    const agent = await tenantMgmtSvc.createAgent(tenantId, {
      name,
      providerConfig: storedProviderConfig,
      systemPrompt: systemPrompt ?? null,
      skills: skills ?? null,
      mcpEndpoints: mcpEndpoints ?? null,
      mergePolicies,
    });

    return reply.code(201).send({ agent: formatAgent({
      id: agent.id,
      name: agent.name,
      provider_config: agent.providerConfig as Record<string, unknown> | null,
      system_prompt: agent.systemPrompt,
      skills: agent.skills as unknown[] | null,
      mcp_endpoints: agent.mcpEndpoints as unknown[] | null,
      merge_policies: agent.mergePolicies as Record<string, unknown>,
      available_models: agent.availableModels,
      conversations_enabled: agent.conversationsEnabled,
      conversation_token_limit: agent.conversationTokenLimit ?? undefined,
      conversation_summary_model: agent.conversationSummaryModel,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    }) });
  });

  // ── GET /v1/portal/agents/:id ─────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/v1/portal/agents/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { id } = request.params;
      const row = await svc.getAgent(id, request.portalUser!.userId);

      if (!row) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      return reply.send({ agent: formatAgent(row) });
    },
  );

  // ── PUT /v1/portal/agents/:id ─────────────────────────────────────────────
  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      providerConfig?: Record<string, unknown>;
      systemPrompt?: string;
      skills?: unknown[];
      mcpEndpoints?: unknown[];
      mergePolicies?: Record<string, unknown>;
      availableModels?: string[] | null;
      conversationsEnabled?: boolean;
      conversationTokenLimit?: number | null;
      conversationSummaryModel?: string | null;
    };
  }>(
    '/v1/portal/agents/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId, userId } = request.portalUser!;
      const { id } = request.params;
      const {
        name, providerConfig, systemPrompt, skills, mcpEndpoints, mergePolicies,
        availableModels, conversationsEnabled, conversationTokenLimit, conversationSummaryModel,
      } = request.body;

      const preparedProviderConfig =
        providerConfig !== undefined
          ? prepareAgentProviderConfig(tenantId, providerConfig)
          : undefined;

      const agent = await tenantMgmtSvc.updateAgent(tenantId, id, {
        name,
        providerConfig: preparedProviderConfig,
        systemPrompt,
        skills,
        mcpEndpoints,
        mergePolicies,
        availableModels,
        conversationsEnabled,
        conversationTokenLimit: conversationTokenLimit ?? undefined,
        conversationSummaryModel,
      });

      return reply.send({ agent: formatAgent({
        id: agent.id,
        name: agent.name,
        provider_config: agent.providerConfig as Record<string, unknown> | null,
        system_prompt: agent.systemPrompt,
        skills: agent.skills as unknown[] | null,
        mcp_endpoints: agent.mcpEndpoints as unknown[] | null,
        merge_policies: agent.mergePolicies as Record<string, unknown>,
        available_models: agent.availableModels,
        conversations_enabled: agent.conversationsEnabled,
        conversation_token_limit: agent.conversationTokenLimit ?? undefined,
        conversation_summary_model: agent.conversationSummaryModel,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
      }) });
    },
  );

  // ── DELETE /v1/portal/agents/:id ──────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/agents/:id',
    { preHandler: ownerRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;

      try {
        await tenantMgmtSvc.deleteAgent(tenantId, id);
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: 'Agent not found' });
      }
    },
  );

  // ── GET /v1/portal/agents/:id/resolved ───────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/v1/portal/agents/:id/resolved',
    { preHandler: authRequired },
    async (request, reply) => {
      const { id } = request.params;
      const data = await svc.getAgentResolved(id, request.portalUser!.userId);

      if (!data) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const { agent, tenantChain } = data;

      // Resolve: first non-null providerConfig (agent first, then tenant chain)
      let resolvedProviderConfig: Record<string, unknown> | null = agent.provider_config ?? null;
      if (!resolvedProviderConfig) {
        for (const t of tenantChain) {
          if (t.provider_config) { resolvedProviderConfig = t.provider_config; break; }
        }
      }

      // Resolve: first non-null systemPrompt
      let resolvedSystemPrompt: string | null = agent.system_prompt ?? null;
      if (!resolvedSystemPrompt) {
        for (const t of tenantChain) {
          if (t.system_prompt) { resolvedSystemPrompt = t.system_prompt; break; }
        }
      }

      // Resolve: union of skills
      const skillsUnion: unknown[] = [];
      const skillsSeen = new Set<string>();
      const addSkills = (arr: unknown[] | null) => {
        if (!arr) return;
        for (const s of arr) {
          const key = JSON.stringify(s);
          if (!skillsSeen.has(key)) { skillsSeen.add(key); skillsUnion.push(s); }
        }
      };
      addSkills(agent.skills);
      for (const t of tenantChain) addSkills(t.skills);

      // Resolve: union of mcpEndpoints
      const endpointsUnion: unknown[] = [];
      const endpointsSeen = new Set<string>();
      const addEndpoints = (arr: unknown[] | null) => {
        if (!arr) return;
        for (const e of arr) {
          const key = JSON.stringify(e);
          if (!endpointsSeen.has(key)) { endpointsSeen.add(key); endpointsUnion.push(e); }
        }
      };
      addEndpoints(agent.mcp_endpoints);
      for (const t of tenantChain) addEndpoints(t.mcp_endpoints);

      const inheritanceChain = [
        { level: 'agent' as const, name: agent.name, id: agent.id },
        ...tenantChain.map((t) => ({ level: 'tenant' as const, name: t.name, id: t.id })),
      ];

      return reply.send({
        resolved: {
          providerConfig: sanitizeAgentProviderConfig(resolvedProviderConfig),
          systemPrompt: resolvedSystemPrompt,
          skills: skillsUnion,
          mcpEndpoints: endpointsUnion,
          mergePolicies: agent.merge_policies,
          inheritanceChain,
        },
      });
    },
  );

  // ── POST /v1/portal/agents/:id/chat ──────────────────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: { messages?: unknown[]; model?: string; conversation_id?: string; partition_id?: string };
  }>(
    '/v1/portal/agents/:id/chat',
    { preHandler: authRequired },
    async (request, reply) => {
      const { userId } = request.portalUser!;
      const { id } = request.params;
      const body = request.body as {
        messages?: unknown[]; model?: string; conversation_id?: string; partition_id?: string;
      };

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({ error: 'messages array is required and must not be empty' });
      }

      const data = await svc.getAgentForChat(id, userId);
      if (!data) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const { agent, tenantChain } = data;

      // Resolve providerConfig: agent first, then tenant chain
      let resolvedProviderConfig: Record<string, unknown> | null = agent.provider_config ?? null;
      if (!resolvedProviderConfig) {
        for (const t of tenantChain) {
          if (t.provider_config) { resolvedProviderConfig = t.provider_config; break; }
        }
      }

      if (!resolvedProviderConfig && !process.env.OPENAI_API_KEY) {
        return reply.code(400).send({ error: 'Agent has no provider configured' });
      }

      // Resolve systemPrompt
      let resolvedSystemPrompt: string | null = agent.system_prompt ?? null;
      if (!resolvedSystemPrompt) {
        for (const t of tenantChain) {
          if (t.system_prompt) { resolvedSystemPrompt = t.system_prompt; break; }
        }
      }

      // Resolve skills union
      const skillsUnion: unknown[] = [];
      const skillsSeen = new Set<string>();
      const addSkills = (arr: unknown[] | null) => {
        if (!arr) return;
        for (const s of arr) {
          const key = JSON.stringify(s);
          if (!skillsSeen.has(key)) { skillsSeen.add(key); skillsUnion.push(s); }
        }
      };
      addSkills(agent.skills);
      for (const t of tenantChain) addSkills(t.skills);

      // Resolve mcpEndpoints union
      const endpointsUnion: unknown[] = [];
      const endpointsSeen = new Set<string>();
      const addEndpoints = (arr: unknown[] | null) => {
        if (!arr) return;
        for (const e of arr) {
          const key = JSON.stringify(e);
          if (!endpointsSeen.has(key)) { endpointsSeen.add(key); endpointsUnion.push(e); }
        }
      };
      addEndpoints(agent.mcp_endpoints);
      for (const t of tenantChain) addEndpoints(t.mcp_endpoints);

      const mergePolicies = (agent.merge_policies as any) ?? { system_prompt: 'prepend', skills: 'merge' };

      const tenantCtx: TenantContext = {
        tenantId: agent.tenant_id,
        name: tenantChain[0]?.name ?? agent.tenant_id,
        agentId: agent.id,
        providerConfig: resolvedProviderConfig as any,
        resolvedSystemPrompt: resolvedSystemPrompt ?? undefined,
        resolvedSkills: skillsUnion.length > 0 ? skillsUnion : undefined,
        resolvedMcpEndpoints: endpointsUnion.length > 0 ? endpointsUnion : undefined,
        mergePolicies,
      };

      const provider = getProviderForTenant(tenantCtx);
      const model = body.model ?? 'gpt-4o-mini';

      // ── Conversation memory ────────────────────────────────────────────────
      let resolvedConversationId: string | undefined;
      let effectiveMessages = body.messages as any[];

      if (agent.conversations_enabled) {
        const incomingConversationId = body.conversation_id ?? crypto.randomUUID();
        try {
          const partitionId = body.partition_id
            ? (await conversationSvc.getOrCreatePartition(
                tenantCtx.tenantId,
                body.partition_id,
              )).id
            : null;

          const conversationUUID = (await conversationSvc.getOrCreateConversation(
            tenantCtx.tenantId,
            partitionId,
            incomingConversationId,
            agent.id,
          )).id;
          resolvedConversationId = incomingConversationId;

          const ctx = await conversationSvc.loadContext(tenantCtx.tenantId, conversationUUID);
          const historyMessages = conversationSvc.buildInjectionMessages(ctx);
          if (historyMessages.length > 0) {
            effectiveMessages = [...historyMessages, ...effectiveMessages];
          }
        } catch (err) {
          fastify.log.warn({ err }, 'Sandbox conversation load failed — continuing without memory');
        }
      }

      const effectiveBody = applyAgentToRequest(
        { model, messages: effectiveMessages, stream: false },
        tenantCtx,
      );

      try {
        const startTimeMs = Date.now();
        const upstreamStartMs = Date.now();
        const response = await provider.proxy({
          url: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: effectiveBody,
        });

        if (response.status >= 400) {
          return reply.code(502).send({ error: 'Provider returned an error', details: response.body });
        }

        const choice = response.body?.choices?.[0];
        if (!choice) {
          return reply.code(502).send({ error: 'Provider returned no choices' });
        }

        const latencyMs = Date.now() - startTimeMs;
        const usage = response.body?.usage;
        traceRecorder.record({
          tenantId: agent.tenant_id,
          agentId: agent.id,
          model: response.body?.model ?? model,
          provider: provider.name,
          requestBody: effectiveBody,
          responseBody: response.body,
          latencyMs,
          statusCode: response.status,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
          ttfbMs: latencyMs,
          gatewayOverheadMs: upstreamStartMs - startTimeMs,
        });
        await traceRecorder.flush();

        if (resolvedConversationId) {
          const partitionId = body.partition_id
            ? (await conversationSvc.getOrCreatePartition(
                tenantCtx.tenantId,
                body.partition_id,
              )).id
            : null;
          const conversationUUID = (await conversationSvc.getOrCreateConversation(
            tenantCtx.tenantId,
            partitionId,
            resolvedConversationId,
            agent.id,
          )).id;
          const userContent = (body.messages[body.messages.length - 1] as any)?.content as string ?? '';
          const assistantContent = choice.message.content ?? '';
          conversationSvc.storeMessages(
            tenantCtx.tenantId, conversationUUID, userContent, assistantContent, null, null,
          ).catch((err) => fastify.log.warn({ err }, 'Failed to store sandbox conversation messages'));
        }

        return reply.send({
          message: choice.message,
          model: response.body.model ?? model,
          usage: response.body.usage ?? null,
          ...(resolvedConversationId ? { conversation_id: resolvedConversationId } : {}),
        });
      } catch (err: any) {
        return reply.code(502).send({ error: 'Provider call failed', details: err?.message ?? String(err) });
      }
    },
  );

  // ── Partitions ────────────────────────────────────────────────────────────

  fastify.get('/v1/portal/partitions', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const rows = await svc.listPartitions(tenantId);

    const flat = rows.map((row) => {
      let title: string | null = null;
      if (row.title_encrypted && row.title_iv) {
        try { title = decryptTraceBody(tenantId, row.title_encrypted, row.title_iv); } catch { /* skip */ }
      }
      return { uuid: row.id, id: row.external_id, parentId: row.parent_id, title, createdAt: row.created_at };
    });

    // Build tree
    const map = new Map<string, any>(flat.map((p) => [p.uuid, { ...p, children: [] }]));
    const roots: any[] = [];
    for (const p of map.values()) {
      if (p.parentId) {
        map.get(p.parentId)?.children.push(p);
      } else {
        roots.push(p);
      }
    }
    return reply.send({ partitions: roots });
  });

  fastify.post<{ Body: { external_id: string; parent_id?: string; title?: string } }>(
    '/v1/portal/partitions',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { external_id, parent_id, title } = request.body;

      if (!external_id || typeof external_id !== 'string') {
        return reply.code(400).send({ error: 'external_id is required' });
      }

      let titleEncrypted: string | null = null;
      let titleIv: string | null = null;
      if (title) {
        const enc = encryptTraceBody(tenantId, title);
        titleEncrypted = enc.ciphertext;
        titleIv = enc.iv;
      }

      try {
        const row = await svc.createPartition(
          tenantId, external_id, parent_id ?? null, titleEncrypted, titleIv,
        );
        return reply.code(201).send({
          uuid: row.id,
          id: row.external_id,
          parentId: row.parent_id,
          title: title ?? null,
          createdAt: row.created_at,
        });
      } catch (err: any) {
        if (err.code === '23505') return reply.code(409).send({ error: 'Partition already exists' });
        throw err;
      }
    },
  );

  fastify.put<{ Params: { id: string }; Body: { title?: string; parent_id?: string | null } }>(
    '/v1/portal/partitions/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;
      const { title, parent_id } = request.body;

      if (title === undefined && parent_id === undefined) {
        return reply.code(400).send({ error: 'No fields to update' });
      }

      const updates: { titleEncrypted?: string; titleIv?: string; parentId?: string | null } = {};
      if (title !== undefined) {
        const enc = encryptTraceBody(tenantId, title);
        updates.titleEncrypted = enc.ciphertext;
        updates.titleIv = enc.iv;
      }
      if (parent_id !== undefined) {
        updates.parentId = parent_id;
      }

      const updated = await svc.updatePartition(id, tenantId, updates);
      if (!updated) return reply.code(404).send({ error: 'Partition not found' });
      return reply.send({ success: true });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/partitions/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;

      const deleted = await svc.deletePartition(id, tenantId);
      if (!deleted) return reply.code(404).send({ error: 'Partition not found' });
      return reply.send({ success: true });
    },
  );

  // ── Conversations ─────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { partition_id?: string } }>(
    '/v1/portal/conversations',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { partition_id } = request.query;

      const rows = await svc.listConversations(tenantId, partition_id ?? null);
      return reply.send({
        conversations: rows.map((row) => ({
          uuid: row.id,
          id: row.external_id,
          agentId: row.agent_id,
          partitionId: row.partition_id,
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
        })),
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/v1/portal/conversations/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;

      const data = await svc.getConversation(id, tenantId);
      if (!data) return reply.code(404).send({ error: 'Conversation not found' });

      const { conv, snapshots, messages } = data;

      const formattedSnapshots = snapshots.map((row) => {
        let summary: string | null = null;
        try { summary = decryptTraceBody(tenantId, row.summary_encrypted, row.summary_iv); } catch { /* skip */ }
        return { id: row.id, summary, messagesArchived: row.messages_archived, createdAt: row.created_at };
      });

      const formattedMessages = messages.map((row) => {
        let content: string | null = null;
        try { content = decryptTraceBody(tenantId, row.content_encrypted, row.content_iv); } catch { /* skip */ }
        return {
          id: row.id,
          role: row.role,
          content,
          tokenEstimate: row.token_estimate,
          snapshotId: row.snapshot_id,
          createdAt: row.created_at,
        };
      });

      return reply.send({
        conversation: {
          uuid: conv.id,
          id: conv.external_id,
          agentId: conv.agent_id,
          partitionId: conv.partition_id,
          createdAt: conv.created_at,
          lastActiveAt: conv.last_active_at,
        },
        snapshots: formattedSnapshots,
        messages: formattedMessages,
      });
    },
  );

  // ── Knowledge Bases ───────────────────────────────────────────────────────

  const registrySvc = new RegistryService();
  const provisionSvc = new ProvisionService(registrySvc);

  // ── GET /v1/portal/knowledge-bases ────────────────────────────────────────
  fastify.get('/v1/portal/knowledge-bases', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const em = orm.em.fork();
    const artifacts = await em.find(
      (await import('../domain/entities/Artifact.js')).Artifact,
      { tenant: tenantId, kind: 'KnowledgeBase' },
      { populate: ['tags', 'vectorSpace'], orderBy: { createdAt: 'DESC' } },
    );
    return reply.send(
      artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        tags: a.tags.map((t: any) => t.tag),
        chunkCount: a.chunkCount,
        createdAt: a.createdAt,
        vectorSpace: a.vectorSpace
          ? { provider: (a.vectorSpace as any).provider, model: (a.vectorSpace as any).model, dimensions: (a.vectorSpace as any).dimensions }
          : null,
      })),
    );
  });

  // ── GET /v1/portal/knowledge-bases/:id ────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/v1/portal/knowledge-bases/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;
      const em = orm.em.fork();
      const { Artifact } = await import('../domain/entities/Artifact.js');
      const artifact = await em.findOne(
        Artifact,
        { id, tenant: tenantId, kind: 'KnowledgeBase' },
        { populate: ['tags', 'vectorSpace'] },
      );
      if (!artifact) return reply.code(404).send({ error: 'Knowledge base not found' });
      const { KbChunk } = await import('../domain/entities/KbChunk.js');
      const liveChunkCount = await em.count(KbChunk, { artifact: artifact.id });
      return reply.send({
        id: artifact.id,
        name: artifact.name,
        org: artifact.org,
        version: artifact.version,
        tags: artifact.tags.map((t: any) => t.tag),
        chunkCount: liveChunkCount,
        searchReady: liveChunkCount > 0,
        createdAt: artifact.createdAt,
        vectorSpace: artifact.vectorSpace
          ? {
              provider: (artifact.vectorSpace as any).provider,
              model: (artifact.vectorSpace as any).model,
              dimensions: (artifact.vectorSpace as any).dimensions,
              preprocessingHash: (artifact.vectorSpace as any).preprocessingHash,
            }
          : null,
      });
    },
  );

  // ── DELETE /v1/portal/knowledge-bases/:id ─────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/knowledge-bases/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;
      const em = orm.em.fork();
      const { Artifact } = await import('../domain/entities/Artifact.js');
      const artifact = await em.findOne(Artifact, { id, tenant: tenantId, kind: 'KnowledgeBase' }, { populate: ['tags'] });
      if (!artifact) return reply.code(404).send({ error: 'Knowledge base not found' });
      // Remove all chunks then the artifact and its tags
      const { KbChunk } = await import('../domain/entities/KbChunk.js');
      const chunks = await em.find(KbChunk, { artifact: artifact.id });
      for (const chunk of chunks) em.remove(chunk);
      for (const tag of artifact.tags) em.remove(tag);
      em.remove(artifact);
      await em.flush();
      return reply.send({ deleted: true });
    },
  );

  // ── Deployments ───────────────────────────────────────────────────────────

  // ── GET /v1/portal/deployments ────────────────────────────────────────────
  fastify.get('/v1/portal/deployments', { preHandler: authRequired }, async (request, reply) => {
    const { tenantId } = request.portalUser!;
    const em = orm.em.fork();
    const deployments = await provisionSvc.listDeployments(tenantId, em);
    return reply.send(
      deployments.map((d) => ({
        id: d.id,
        status: d.status,
        environment: d.environment,
        deployedAt: d.deployedAt,
        artifact: d.artifact
          ? { name: (d.artifact as any).name, tag: (d.artifact as any).version, kind: (d.artifact as any).kind }
          : null,
      })),
    );
  });

  // ── GET /v1/portal/deployments/:id ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/v1/portal/deployments/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;
      const em = orm.em.fork();
      const deployment = await provisionSvc.getDeployment(id, tenantId, em);
      if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });
      await em.populate(deployment, ['artifact', 'artifact.vectorSpace'] as any);
      const artifact = deployment.artifact as any;
      let chunkCount: number | null = null;
      if (artifact && artifact.kind === 'KnowledgeBase') {
        const { KbChunk } = await import('../domain/entities/KbChunk.js');
        chunkCount = await em.count(KbChunk, { artifact: artifact.id });
      }
      return reply.send({
        id: deployment.id,
        status: deployment.status,
        environment: deployment.environment,
        deployedAt: deployment.deployedAt,
        createdAt: deployment.createdAt,
        artifact: artifact
          ? {
              name: artifact.name,
              tag: artifact.version,
              kind: artifact.kind,
              chunkCount: artifact.kind === 'KnowledgeBase' ? chunkCount : undefined,
            }
          : null,
      });
    },
  );

  // ── DELETE /v1/portal/deployments/:id ────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/portal/deployments/:id',
    { preHandler: authRequired },
    async (request, reply) => {
      const { tenantId } = request.portalUser!;
      const { id } = request.params;
      const em = orm.em.fork();
      const ok = await provisionSvc.unprovision(id, tenantId, em);
      if (!ok) return reply.code(404).send({ error: 'Deployment not found' });
      return reply.send({ success: true });
    },
  );
}
