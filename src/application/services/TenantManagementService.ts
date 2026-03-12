import type { EntityManager } from '@mikro-orm/core';
import { Tenant } from '../../domain/entities/Tenant.js';
import { Agent } from '../../domain/entities/Agent.js';
import { ApiKey } from '../../domain/entities/ApiKey.js';
import { TenantMembership } from '../../domain/entities/TenantMembership.js';
import { User } from '../../domain/entities/User.js';
import { Invite } from '../../domain/entities/Invite.js';
import { evictProvider } from '../../providers/registry.js';
import type {
  TenantViewModel,
  MemberViewModel,
  InviteViewModel,
  CreateInviteDto,
  UpdateTenantDto,
  CreateSubtenantDto,
} from '../dtos/tenant.dto.js';
import type {
  AgentViewModel,
  CreateAgentDto,
  UpdateAgentDto,
  ApiKeyViewModel,
  ApiKeyCreatedViewModel,
  CreateApiKeyDto,
} from '../dtos/agent.dto.js';

function toTenantViewModel(t: Tenant): TenantViewModel {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    providerConfig: t.providerConfig,
    systemPrompt: t.systemPrompt,
    skills: t.skills,
    mcpEndpoints: t.mcpEndpoints,
    availableModels: t.availableModels,
    createdAt: t.createdAt.toISOString(),
  };
}

function toAgentViewModel(a: Agent): AgentViewModel {
  return {
    id: a.id,
    tenantId: (a.tenant as any)?.id ?? '',
    name: a.name,
    providerConfig: a.providerConfig,
    systemPrompt: a.systemPrompt,
    skills: a.skills,
    mcpEndpoints: a.mcpEndpoints,
    mergePolicies: a.mergePolicies,
    availableModels: a.availableModels,
    conversationsEnabled: a.conversationsEnabled,
    conversationTokenLimit: a.conversationTokenLimit,
    conversationSummaryModel: a.conversationSummaryModel,
    knowledgeBaseRef: a.knowledgeBaseRef,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt ? a.updatedAt.toISOString() : null,
  };
}

function toApiKeyViewModel(k: ApiKey): ApiKeyViewModel {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    status: k.status,
    createdAt: k.createdAt.toISOString(),
    agentId: (k.agent as any)?.id ?? '',
    agentName: (k.agent as any)?.name ?? '',
  };
}

export interface TenantContext {
  tenant: Tenant;
  user: User;
  membership: TenantMembership;
}

export class TenantManagementService {
  constructor(private readonly em: EntityManager) {}

  async findByOrgSlug(slug: string): Promise<Tenant | null> {
    return this.em.findOne(Tenant, { orgSlug: slug });
  }

  async getContext(tenantId: string, userId: string): Promise<TenantContext> {
    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId });
    const user = await this.em.findOneOrFail(User, { id: userId });
    const membership = await this.em.findOneOrFail(TenantMembership, {
      tenant: tenantId,
      user: userId,
    });
    return { tenant, user, membership };
  }

  async updateSettings(tenantId: string, dto: UpdateTenantDto): Promise<TenantViewModel> {
    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId });
    if (dto.name !== undefined) tenant.name = dto.name;
    if (dto.orgSlug !== undefined) tenant.orgSlug = dto.orgSlug;
    const providerConfigChanged = dto.providerConfig !== undefined;
    if (dto.providerConfig !== undefined) tenant.providerConfig = dto.providerConfig;
    if (dto.systemPrompt !== undefined) tenant.systemPrompt = dto.systemPrompt;
    if (dto.skills !== undefined) tenant.skills = dto.skills;
    if (dto.mcpEndpoints !== undefined) tenant.mcpEndpoints = dto.mcpEndpoints;
    if (dto.availableModels !== undefined) tenant.availableModels = dto.availableModels;
    if (dto.status !== undefined) tenant.status = dto.status;
    tenant.updatedAt = new Date();
    await this.em.flush();
    
    if (providerConfigChanged) {
      evictProvider(tenantId);
    }
    
    return toTenantViewModel(tenant);
  }

  async inviteUser(
    tenantId: string,
    createdByUserId: string,
    dto: CreateInviteDto,
  ): Promise<InviteViewModel> {
    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId }, { populate: ['invites'] });
    const createdBy = await this.em.findOneOrFail(User, { id: createdByUserId });
    const invite = tenant.createInvite(createdBy, dto.maxUses, dto.expiresInDays);
    this.em.persist(invite);
    await this.em.flush();
    return {
      id: invite.id,
      token: invite.token,
      tenantId: tenant.id,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
      expiresAt: invite.expiresAt.toISOString(),
      revokedAt: null,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  async listMembers(tenantId: string): Promise<MemberViewModel[]> {
    const memberships = await this.em.find(
      TenantMembership,
      { tenant: tenantId },
      { populate: ['user'] },
    );
    return memberships.map((m) => ({
      userId: (m.user as any)?.id ?? '',
      email: (m.user as any)?.email ?? '',
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  async createSubtenant(parentTenantId: string, dto: CreateSubtenantDto): Promise<TenantViewModel> {
    const parent = await this.em.findOneOrFail(
      Tenant,
      { id: parentTenantId },
      { populate: ['members', 'members.user'] },
    );
    const child = parent.createSubtenant(dto.name);
    this.em.persist(child);
    await this.em.flush();
    return toTenantViewModel(child);
  }

  async createAgent(tenantId: string, dto: CreateAgentDto): Promise<AgentViewModel> {
    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId });
    const agent = tenant.createAgent(dto.name, {
      providerConfig: dto.providerConfig,
      systemPrompt: dto.systemPrompt,
      skills: dto.skills,
      mcpEndpoints: dto.mcpEndpoints,
      mergePolicies: dto.mergePolicies,
      availableModels: dto.availableModels,
      conversationsEnabled: dto.conversationsEnabled,
      conversationTokenLimit: dto.conversationTokenLimit,
      conversationSummaryModel: dto.conversationSummaryModel,
    });
    this.em.persist(agent);
    await this.em.flush();
    return toAgentViewModel(agent);
  }

  async updateAgent(
    tenantId: string,
    agentId: string,
    dto: UpdateAgentDto,
  ): Promise<AgentViewModel> {
    const agent = await this.em.findOneOrFail(Agent, { id: agentId, tenant: tenantId });
    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.providerConfig !== undefined) agent.providerConfig = dto.providerConfig;
    if (dto.systemPrompt !== undefined) agent.systemPrompt = dto.systemPrompt;
    if (dto.skills !== undefined) agent.skills = dto.skills;
    if (dto.mcpEndpoints !== undefined) agent.mcpEndpoints = dto.mcpEndpoints;
    if (dto.mergePolicies !== undefined) agent.mergePolicies = dto.mergePolicies;
    if (dto.availableModels !== undefined) agent.availableModels = dto.availableModels;
    if (dto.conversationsEnabled !== undefined) agent.conversationsEnabled = dto.conversationsEnabled;
    if (dto.conversationTokenLimit !== undefined) agent.conversationTokenLimit = dto.conversationTokenLimit;
    if (dto.conversationSummaryModel !== undefined) agent.conversationSummaryModel = dto.conversationSummaryModel;
    agent.updatedAt = new Date();
    await this.em.flush();

    // Evict provider cache when agent configuration changes
    evictProvider(agentId);

    return toAgentViewModel(agent);
  }

  async deleteAgent(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.em.findOneOrFail(Agent, { id: agentId, tenant: tenantId });
    await this.em.removeAndFlush(agent);
  }

  async createApiKey(
    tenantId: string,
    agentId: string,
    dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedViewModel> {
    const agent = await this.em.findOneOrFail(Agent, { id: agentId, tenant: tenantId }, { populate: ['tenant', 'apiKeys'] });
    const { entity: apiKey, rawKey } = agent.createApiKey(dto.name ?? 'Default Key');
    this.em.persist(apiKey);
    await this.em.flush();
    return { ...toApiKeyViewModel(apiKey), rawKey };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<{ keyHash: string }> {
    const key = await this.em.findOneOrFail(ApiKey, { id: keyId, tenant: tenantId });
    const keyHash = key.keyHash;
    key.status = 'revoked';
    key.revokedAt = new Date();
    await this.em.flush();
    return { keyHash };
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyViewModel[]> {
    const keys = await this.em.find(ApiKey, { tenant: tenantId }, { populate: ['agent'] });
    return keys.map(toApiKeyViewModel);
  }

  async revokeInvite(tenantId: string, inviteId: string): Promise<void> {
    const invite = await this.em.findOne(Invite, { id: inviteId, tenant: tenantId });
    
    if (!invite) {
      throw Object.assign(new Error('Invite not found'), { status: 404 });
    }
    
    invite.revokedAt = new Date();
    await this.em.flush();
  }

  async listInvites(tenantId: string): Promise<InviteViewModel[]> {
    const invites = await this.em.find(Invite, { tenant: tenantId });
    return invites.map((invite) => ({
      id: invite.id,
      token: invite.token,
      tenantId: (invite.tenant as any)?.id ?? tenantId,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
      expiresAt: invite.expiresAt.toISOString(),
      revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
      createdAt: invite.createdAt.toISOString(),
    }));
  }

  async updateMemberRole(
    tenantId: string,
    targetUserId: string,
    role: 'owner' | 'member',
  ): Promise<void> {
    const membership = await this.em.findOneOrFail(TenantMembership, {
      tenant: tenantId,
      user: targetUserId,
    });

    // If demoting from owner to member, check we're not removing the last owner
    if (membership.role === 'owner' && role === 'member') {
      const ownerCount = await this.em.count(TenantMembership, {
        tenant: tenantId,
        role: 'owner',
      });

      if (ownerCount === 1) {
        throw Object.assign(new Error('Cannot demote the last owner'), { status: 400 });
      }
    }

    membership.role = role;
    await this.em.flush();
  }

  async removeMember(
    tenantId: string,
    targetUserId: string,
    requestingUserId: string,
  ): Promise<void> {
    if (targetUserId === requestingUserId) {
      throw Object.assign(new Error('Use leave instead'), { status: 400 });
    }

    const membership = await this.em.findOne(TenantMembership, {
      tenant: tenantId,
      user: targetUserId,
    });

    if (!membership) {
      throw Object.assign(new Error('Membership not found'), { status: 404 });
    }

    // If removing an owner, check we're not removing the last owner
    if (membership.role === 'owner') {
      const ownerCount = await this.em.count(TenantMembership, {
        tenant: tenantId,
        role: 'owner',
      });

      if (ownerCount === 1) {
        throw Object.assign(new Error('Cannot remove the last owner'), { status: 400 });
      }
    }

    await this.em.removeAndFlush(membership);
  }
}
