import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import { ApiKey } from '../../domain/entities/ApiKey.js';
import { Tenant } from '../../domain/entities/Tenant.js';
import { Agent } from '../../domain/entities/Agent.js';
import { ProviderBase } from '../../domain/entities/ProviderBase.js';
import type {
  TenantContext,
  TenantProviderConfig,
  MergePolicy,
  AgentConfig,
} from '../../auth.js';

function resolveArrayChain(arrays: any[][], nameOf: (item: any) => string | undefined): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const name = nameOf(item);
      if (name && !seen.has(name)) {
        seen.add(name);
        result.push(item);
      } else if (!name) {
        result.push(item);
      }
    }
  }
  return result;
}

export class TenantService {
  constructor(private readonly em: EntityManager) {}

  async loadByApiKey(rawKey: string): Promise<{ context: TenantContext; expiresAt: Date | null }> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.em.findOne(
      ApiKey,
      { keyHash, status: 'active' },
      { populate: ['agent', 'tenant'] },
    );

    if (!apiKey) throw new Error('Invalid API key');

    // Check expiry — a non-null expiresAt in the past means the key is expired
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      throw new Error('API key has expired');
    }

    const tenant = apiKey.tenant as Tenant;
    if (tenant.status !== 'active') throw new Error('Tenant is not active');

    const agent = apiKey.agent as Agent;

    // Walk the parent chain if needed
    type ChainEntry = {
      providerConfig: TenantProviderConfig | null;
      systemPrompt: string | null;
      skills: any[] | null;
      mcpEndpoints: any[] | null;
    };

    const chain: ChainEntry[] = [
      {
        providerConfig: agent?.providerConfig ?? null,
        systemPrompt: agent?.systemPrompt ?? null,
        skills: agent?.skills ?? null,
        mcpEndpoints: agent?.mcpEndpoints ?? null,
      },
      {
        providerConfig: tenant.providerConfig,
        systemPrompt: tenant.systemPrompt,
        skills: tenant.skills,
        mcpEndpoints: tenant.mcpEndpoints,
      },
    ];

    // Walk parent chain
    if (tenant.parentId) {
      let currentParentId: string | null = tenant.parentId;
      let hops = 0;
      while (currentParentId && hops < 10) {
        const parent: Tenant | null = await this.em.findOne(Tenant, { id: currentParentId });
        if (!parent) break;
        chain.push({
          providerConfig: parent.providerConfig,
          systemPrompt: parent.systemPrompt,
          skills: parent.skills,
          mcpEndpoints: parent.mcpEndpoints,
        });
        currentParentId = parent.parentId;
        hops++;
      }
    }

    const resolvedProviderConfig =
      chain.find((c) => c.providerConfig != null)?.providerConfig ?? undefined;

    // Provider entity resolution chain:
    // 1. agent.providerId (direct FK — highest priority)
    // 2. tenant.defaultProviderId (tenant-level default)
    // 3. resolvedProviderConfig.gatewayProviderId (JSONB bridge)
    // 4. Legacy JSONB providerConfig (existing fallback, handled by registry)
    let providerEntity: ProviderBase | undefined;
    if (agent?.providerId) {
      const found = await this.em.findOne(ProviderBase, agent.providerId);
      if (found) {
        providerEntity = found;
      }
    } else if (tenant.defaultProviderId) {
      const found = await this.em.findOne(ProviderBase, tenant.defaultProviderId);
      if (found) {
        providerEntity = found;
      }
    } else if (resolvedProviderConfig?.gatewayProviderId) {
      const found = await this.em.findOne(ProviderBase, resolvedProviderConfig.gatewayProviderId);
      if (found) {
        providerEntity = found;
      }
    }

    const resolvedSystemPrompt =
      chain.find((c) => c.systemPrompt != null)?.systemPrompt ?? undefined;

    const resolvedSkills = resolveArrayChain(
      chain.map((c) => c.skills).filter(Boolean) as any[][],
      (item) => item?.function?.name ?? item?.name,
    );

    const resolvedMcpEndpoints = resolveArrayChain(
      chain.map((c) => c.mcpEndpoints).filter(Boolean) as any[][],
      (item) => item?.name,
    );

    const mergePolicies: MergePolicy = agent?.mergePolicies ?? {
      system_prompt: 'prepend',
      skills: 'merge',
    };

    const agentConfig: AgentConfig = {
      conversations_enabled: agent?.conversationsEnabled ?? false,
      conversation_token_limit: agent?.conversationTokenLimit ?? 4000,
      conversation_summary_model: agent?.conversationSummaryModel ?? null,
    };

    return {
      context: {
        tenantId: tenant.id,
        name: tenant.name,
        agentId: agent?.id ?? undefined,
        knowledgeBaseRef: agent?.knowledgeBaseRef ?? undefined,
        providerConfig: resolvedProviderConfig,
        providerEntity,
        agentSystemPrompt: agent?.systemPrompt ?? undefined,
        agentSkills: agent?.skills ?? undefined,
        agentMcpEndpoints: agent?.mcpEndpoints ?? undefined,
        mergePolicies,
        resolvedSystemPrompt,
        resolvedSkills: resolvedSkills.length ? resolvedSkills : undefined,
        resolvedMcpEndpoints: resolvedMcpEndpoints.length ? resolvedMcpEndpoints : undefined,
        agentConfig,
      },
      expiresAt: apiKey.expiresAt ?? null,
    };
  }
}
