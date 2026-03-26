/**
 * PortalService — encapsulates all database access for portal routes.
 * Route handlers stay thin: parse HTTP → call PortalService → return DTO.
 *
 * Migrated from raw SQL (Knex) to MikroORM entity operations.
 * Recursive CTEs for tenant chain resolution use em.getConnection().execute().
 */
import type { EntityManager } from '@mikro-orm/core';
import { User } from '../../domain/entities/User.js';
import { Tenant } from '../../domain/entities/Tenant.js';
import { TenantMembership } from '../../domain/entities/TenantMembership.js';
import { Agent } from '../../domain/entities/Agent.js';
import { OpenAIProvider } from '../../domain/entities/OpenAIProvider.js';
import { AzureProvider } from '../../domain/entities/AzureProvider.js';
import { OllamaProvider } from '../../domain/entities/OllamaProvider.js';
import { Invite } from '../../domain/entities/Invite.js';
import { BetaSignup } from '../../domain/entities/BetaSignup.js';
import { Trace } from '../../domain/entities/Trace.js';
import { Partition } from '../../domain/entities/Partition.js';
import { Conversation } from '../../domain/entities/Conversation.js';
import { ConversationMessage } from '../../domain/entities/ConversationMessage.js';
import { ConversationSnapshot } from '../../domain/entities/ConversationSnapshot.js';
import { randomUUID } from 'node:crypto';

export class PortalService {
  constructor(private readonly em: EntityManager) {}

  // ── Profile ───────────────────────────────────────────────────────────────

  async getMe(userId: string, tenantId: string) {
    const membership = await this.em.findOne(
      TenantMembership,
      { user: userId, tenant: tenantId },
      { populate: ['user', 'tenant'] },
    );
    if (!membership) return null;

    const user = membership.user;
    const tenant = membership.tenant;

    const allMemberships = await this.em.find(
      TenantMembership,
      { user: userId, tenant: { status: 'active' } },
      { populate: ['tenant'], orderBy: { joinedAt: 'ASC' } },
    );

    const [agents, subtenants] = await Promise.all([
      this.em.find(Agent, { tenant: tenantId }, { orderBy: { createdAt: 'ASC' } }),
      this.em.find(Tenant, { parentId: tenantId }, { orderBy: { createdAt: 'ASC' } }),
    ]);

    return {
      row: {
        id: user.id,
        email: user.email,
        role: membership.role,
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        org_slug: tenant.orgSlug,
        default_provider_id: tenant.defaultProviderId ?? null,
        provider_config: tenant.providerConfig,
        available_models: tenant.availableModels,
      },
      tenants: allMemberships.map((m) => ({
        tenant_id: m.tenant.id,
        tenant_name: m.tenant.name,
        role: m.role,
      })),
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      subtenants: subtenants.map((s) => ({ id: s.id, name: s.name, status: s.status })),
    };
  }

  // ── Traces ────────────────────────────────────────────────────────────────

  async listTraces(tenantId: string, limit: number, cursor?: string) {
    const traces = await this.em.find(
      Trace,
      {
        tenant: tenantId,
        ...(cursor ? { createdAt: { $lt: new Date(cursor) } } : {}),
      },
      {
        orderBy: { createdAt: 'DESC' },
        limit,
      },
    );

    return traces.map((t) => ({
      id: t.id,
      tenant_id: (t.tenant as any)?.id ?? tenantId,
      model: t.model,
      provider: t.provider,
      status_code: t.statusCode,
      latency_ms: t.latencyMs,
      prompt_tokens: t.promptTokens,
      completion_tokens: t.completionTokens,
      ttfb_ms: t.ttfbMs,
      gateway_overhead_ms: t.gatewayOverheadMs,
      created_at: t.createdAt,
    }));
  }

  // ── Tenants ───────────────────────────────────────────────────────────────

  async listUserTenants(userId: string) {
    const memberships = await this.em.find(
      TenantMembership,
      { user: userId, tenant: { status: 'active' } },
      { populate: ['tenant'], orderBy: { joinedAt: 'ASC' } },
    );

    return memberships.map((m) => ({
      tenant_id: m.tenant.id,
      tenant_name: m.tenant.name,
      role: m.role,
      joined_at: m.joinedAt,
    }));
  }

  async getInviteInfo(token: string) {
    // First check if it's a beta signup invite code.
    // Beta invite codes are UUIDs, while tenant invite tokens are base64url strings.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (UUID_RE.test(token)) {
      const beta = await this.em.findOne(BetaSignup, { inviteCode: token });
      if (beta) {
        return {
          tenant_name: 'Arachne',
          expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          revoked_at: null,
          max_uses: 1,
          use_count: beta.inviteUsedAt ? 1 : 0,
          tenant_status: 'active',
        };
      }
    }

    // Otherwise check for tenant invite
    const invite = await this.em.findOne(Invite, { token }, { populate: ['tenant'] });
    if (!invite) return null;

    return {
      tenant_name: invite.tenant.name,
      expires_at: invite.expiresAt,
      revoked_at: invite.revokedAt,
      max_uses: invite.maxUses,
      use_count: invite.useCount,
      tenant_status: invite.tenant.status,
    };
  }

  async listSubtenants(tenantId: string) {
    const tenants = await this.em.find(
      Tenant,
      { parentId: tenantId },
      { orderBy: { createdAt: 'ASC' } },
    );

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      parent_id: t.parentId,
      status: t.status,
      created_at: t.createdAt,
    }));
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(tenantId: string) {
    const agents = await this.em.find(
      Agent,
      { tenant: tenantId },
      { orderBy: { createdAt: 'ASC' } },
    );

    // Resolve provider available models for agents that don't have their own list.
    // Collect unique provider IDs, then batch-load them.
    const providerIds = new Set<string>();
    for (const a of agents) {
      if (!a.availableModels || a.availableModels.length === 0) {
        const pid = this.getAgentProviderId(a);
        if (pid) providerIds.add(pid);
      }
    }

    // Also check for tenant's provider (via providerConfig.gatewayProviderId)
    const tenant = await this.em.findOne(Tenant, { id: tenantId });
    const tenantProviderId = this.getTenantProviderId(tenant);
    if (tenantProviderId) {
      providerIds.add(tenantProviderId);
    }

    const providerModelsMap = new Map<string, string[]>();
    if (providerIds.size > 0) {
      for (const ProviderClass of [OpenAIProvider, AzureProvider, OllamaProvider]) {
        const providers = await this.em.find(ProviderClass, { id: { $in: [...providerIds] } });
        for (const p of providers) {
          if (p.availableModels && p.availableModels.length > 0) {
            providerModelsMap.set(p.id, p.availableModels);
          }
        }
      }
    }

    return agents.map((a) => {
      // Resolve effective available models: agent's own → agent's provider → tenant default provider
      let effectiveModels = a.availableModels;
      if (!effectiveModels || effectiveModels.length === 0) {
        const pid = this.getAgentProviderId(a);
        if (pid && providerModelsMap.has(pid)) {
          effectiveModels = providerModelsMap.get(pid)!;
        } else if (tenantProviderId && providerModelsMap.has(tenantProviderId)) {
          effectiveModels = providerModelsMap.get(tenantProviderId)!;
        }
      }

      return {
        id: a.id,
        name: a.name,
        provider_config: a.providerConfig,
        system_prompt: a.systemPrompt,
        skills: a.skills,
        mcp_endpoints: a.mcpEndpoints,
        merge_policies: a.mergePolicies,
        available_models: effectiveModels,
        conversations_enabled: a.conversationsEnabled,
        conversation_token_limit: a.conversationTokenLimit,
        conversation_summary_model: a.conversationSummaryModel,
        knowledge_base_ref: a.knowledgeBaseRef,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
      };
    });
  }

  async getAgent(agentId: string, userId: string) {
    // Find agent where the user has membership in the agent's tenant
    const agent = await this.em.findOne(Agent, { id: agentId });
    if (!agent) return null;

    const membership = await this.em.findOne(TenantMembership, {
      tenant: (agent.tenant as any)?.id ?? agent.tenant,
      user: userId,
    });
    if (!membership) return null;

    // Resolve effective available models from provider chain
    const effectiveModels = await this.resolveAgentAvailableModels(agent);

    return {
      id: agent.id,
      name: agent.name,
      provider_config: agent.providerConfig,
      system_prompt: agent.systemPrompt,
      skills: agent.skills,
      mcp_endpoints: agent.mcpEndpoints,
      merge_policies: agent.mergePolicies,
      available_models: effectiveModels,
      conversations_enabled: agent.conversationsEnabled,
      conversation_token_limit: agent.conversationTokenLimit,
      conversation_summary_model: agent.conversationSummaryModel,
      knowledge_base_ref: agent.knowledgeBaseRef,
      created_at: agent.createdAt,
      updated_at: agent.updatedAt,
    };
  }

  /**
   * Extract the effective provider ID from a providerConfig object.
   */
  private extractProviderId(cfg: any): string | null {
    if (cfg && typeof cfg === 'object' && 'gatewayProviderId' in cfg) {
      return (cfg as Record<string, unknown>).gatewayProviderId as string ?? null;
    }
    return null;
  }

  /**
   * Extract the effective provider ID for an agent.
   * Checks agent.providerId first, then falls back to providerConfig.gatewayProviderId.
   */
  private getAgentProviderId(agent: Agent): string | null {
    return this.extractProviderId(agent.providerConfig);
  }

  /**
   * Extract the provider ID from a tenant's providerConfig.
   */
  private getTenantProviderId(tenant: Tenant | null): string | null {
    if (!tenant) return null;
    return this.extractProviderId(tenant.providerConfig);
  }

  /**
   * Resolve effective available models for an agent.
   * Falls back: agent's own list → agent's provider → tenant's provider.
   */
  private async resolveAgentAvailableModels(agent: Agent): Promise<string[] | null> {
    if (agent.availableModels && agent.availableModels.length > 0) {
      return agent.availableModels;
    }

    const agentProviderId = this.getAgentProviderId(agent);
    const providerIds: string[] = [];
    if (agentProviderId) providerIds.push(agentProviderId);

    const tenantId = (agent.tenant as any)?.id ?? agent.tenant;
    const tenant = await this.em.findOne(Tenant, { id: tenantId });
    const tenantProviderId = this.getTenantProviderId(tenant);
    if (tenantProviderId && tenantProviderId !== agentProviderId) {
      providerIds.push(tenantProviderId);
    }

    for (const pid of providerIds) {
      for (const ProviderClass of [OpenAIProvider, AzureProvider, OllamaProvider]) {
        const provider = await this.em.findOne(ProviderClass, { id: pid });
        if (provider?.availableModels && provider.availableModels.length > 0) {
          return provider.availableModels;
        }
      }
    }

    return null;
  }

  async getAgentResolved(agentId: string, userId: string) {
    const agent = await this.em.findOne(Agent, { id: agentId }, { populate: ['tenant'] });
    if (!agent) return null;

    const tenantId = agent.tenant.id;
    const membership = await this.em.findOne(TenantMembership, {
      tenant: tenantId,
      user: userId,
    });
    if (!membership) return null;

    const tenantChain = await this.loadTenantChain(tenantId);

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        tenant_id: tenantId,
        provider_config: agent.providerConfig,
        system_prompt: agent.systemPrompt,
        skills: agent.skills,
        mcp_endpoints: agent.mcpEndpoints,
        merge_policies: agent.mergePolicies,
      },
      tenantChain,
    };
  }

  async getAgentForChat(agentId: string, userId: string) {
    const agent = await this.em.findOne(Agent, { id: agentId }, { populate: ['tenant'] });
    if (!agent) return null;

    const tenantId = agent.tenant.id;
    const membership = await this.em.findOne(TenantMembership, {
      tenant: tenantId,
      user: userId,
    });
    if (!membership) return null;

    const tenantChain = await this.loadTenantChain(tenantId);

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        tenant_id: tenantId,
        provider_config: agent.providerConfig,
        system_prompt: agent.systemPrompt,
        skills: agent.skills,
        mcp_endpoints: agent.mcpEndpoints,
        merge_policies: agent.mergePolicies,
        conversations_enabled: agent.conversationsEnabled,
        conversation_token_limit: agent.conversationTokenLimit,
        conversation_summary_model: agent.conversationSummaryModel,
        knowledge_base_ref: agent.knowledgeBaseRef,
      },
      tenantChain,
    };
  }

  /**
   * Load the tenant inheritance chain using recursive CTE.
   * Uses Knex raw query with ? placeholders (single parameter, no reuse issue).
   */
  private async loadTenantChain(tenantId: string): Promise<Array<{
    id: string; name: string;
    provider_config: Record<string, unknown> | null;
    system_prompt: string | null;
    skills: unknown[] | null;
    mcp_endpoints: unknown[] | null;
    depth: number;
  }>> {
    const knex = (this.em as any).getKnex();
    const result = await knex.raw(
      `WITH RECURSIVE tenant_chain AS (
         SELECT id, name, parent_id, provider_config, system_prompt, skills, mcp_endpoints, 0 AS depth
         FROM tenants WHERE id = ?
         UNION ALL
         SELECT t.id, t.name, t.parent_id, t.provider_config, t.system_prompt, t.skills, t.mcp_endpoints, tc.depth + 1
         FROM tenants t
         JOIN tenant_chain tc ON t.id = tc.parent_id
       )
       SELECT id, name, provider_config, system_prompt, skills, mcp_endpoints, depth
       FROM tenant_chain ORDER BY depth ASC`,
      [tenantId],
    );
    return result.rows;
  }

  // ── Partitions ────────────────────────────────────────────────────────────

  async listPartitions(tenantId: string) {
    const partitions = await this.em.find(
      Partition,
      { tenant: tenantId },
      { orderBy: { createdAt: 'ASC' } },
    );

    return partitions.map((p) => ({
      id: p.id,
      parent_id: p.parentId,
      external_id: p.externalId,
      title_encrypted: p.titleEncrypted,
      title_iv: p.titleIv,
      created_at: p.createdAt,
    }));
  }

  async createPartition(
    tenantId: string,
    externalId: string,
    parentId: string | null,
    titleEncrypted: string | null,
    titleIv: string | null,
  ) {
    const partition = new Partition();
    partition.id = randomUUID();
    partition.tenant = this.em.getReference(Tenant, tenantId);
    partition.externalId = externalId;
    partition.parentId = parentId;
    partition.titleEncrypted = titleEncrypted;
    partition.titleIv = titleIv;
    partition.createdAt = new Date();
    this.em.persist(partition);
    await this.em.flush();

    return {
      id: partition.id,
      external_id: partition.externalId,
      parent_id: partition.parentId,
      created_at: partition.createdAt,
    };
  }

  async updatePartition(
    id: string,
    tenantId: string,
    updates: {
      titleEncrypted?: string;
      titleIv?: string;
      parentId?: string | null;
    },
  ): Promise<boolean> {
    const partition = await this.em.findOne(Partition, { id, tenant: tenantId });
    if (!partition) return false;

    if (updates.titleEncrypted !== undefined && updates.titleIv !== undefined) {
      partition.titleEncrypted = updates.titleEncrypted;
      partition.titleIv = updates.titleIv;
    }
    if ('parentId' in updates) {
      partition.parentId = updates.parentId!;
    }

    await this.em.flush();
    return true;
  }

  async deletePartition(id: string, tenantId: string): Promise<boolean> {
    const partition = await this.em.findOne(Partition, { id, tenant: tenantId });
    if (!partition) return false;
    await this.em.removeAndFlush(partition);
    return true;
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  async listConversations(tenantId: string, partitionId?: string | null) {
    const conversations = await this.em.find(
      Conversation,
      {
        tenant: tenantId,
        ...(partitionId ? { partition: partitionId } : {}),
      },
      {
        orderBy: { lastActiveAt: 'DESC' },
        populate: ['messageCount'] as const,
      },
    );

    return conversations.map((c) => ({
      id: c.id,
      agent_id: (c.agent as any)?.id ?? null,
      partition_id: (c.partition as any)?.id ?? null,
      external_id: c.externalId,
      created_at: c.createdAt,
      last_active_at: c.lastActiveAt,
      message_count: c.messageCount ?? 0,
    }));
  }

  async getConversation(id: string, tenantId: string) {
    const conv = await this.em.findOne(Conversation, { id, tenant: tenantId });
    if (!conv) return null;

    const snapshots = await this.em.find(
      ConversationSnapshot,
      { conversation: id },
      { orderBy: { createdAt: 'ASC' } },
    );

    const messages = await this.em.find(
      ConversationMessage,
      { conversation: id },
      { orderBy: { createdAt: 'ASC' } },
    );

    return {
      conv: {
        id: conv.id,
        agent_id: (conv.agent as any)?.id ?? null,
        partition_id: (conv.partition as any)?.id ?? null,
        external_id: conv.externalId,
        created_at: conv.createdAt,
        last_active_at: conv.lastActiveAt,
      },
      snapshots: snapshots.map((s) => ({
        id: s.id,
        summary_encrypted: s.summaryEncrypted,
        summary_iv: s.summaryIv,
        messages_archived: s.messagesArchived,
        created_at: s.createdAt,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content_encrypted: m.contentEncrypted,
        content_iv: m.contentIv,
        token_estimate: m.tokenEstimate,
        snapshot_id: m.snapshotId,
        created_at: m.createdAt,
      })),
    };
  }
}
