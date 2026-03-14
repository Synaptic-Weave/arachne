import { randomUUID } from 'node:crypto';
import { Collection } from '@mikro-orm/core';
import type { Tenant } from './Tenant.js';
import { ApiKey } from './ApiKey.js';

export type AgentKind = 'inference' | 'embedding';

export class Agent {
  id!: string;
  tenant!: Tenant;
  name!: string;
  kind!: AgentKind;
  providerConfig!: any | null;
  systemPrompt!: string | null;
  skills!: any[] | null;
  mcpEndpoints!: any[] | null;
  mergePolicies!: any;
  availableModels!: any[] | null;
  knowledgeBaseRef!: string | null;
  conversationsEnabled!: boolean;
  conversationTokenLimit!: number;
  conversationSummaryModel!: string | null;
  sandboxKey!: string | null;
  createdAt!: Date;
  updatedAt!: Date | null;

  apiKeys = new Collection<ApiKey>(this);

  constructor(tenant: Tenant, name: string, config?: Partial<Agent>) {
    this.id = randomUUID();
    this.tenant = tenant;
    this.name = name;
    this.kind = config?.kind ?? 'inference';
    this.providerConfig = config?.providerConfig ?? null;
    this.systemPrompt = config?.systemPrompt ?? null;
    this.skills = config?.skills ?? null;
    this.mcpEndpoints = config?.mcpEndpoints ?? null;
    this.mergePolicies = config?.mergePolicies ?? {
      system_prompt: 'prepend',
      skills: 'merge',
      mcp_endpoints: 'merge',
    };
    this.availableModels = config?.availableModels ?? null;
    this.knowledgeBaseRef = config?.knowledgeBaseRef ?? null;
    this.conversationsEnabled = config?.conversationsEnabled ?? false;
    this.conversationTokenLimit = config?.conversationTokenLimit ?? 4000;
    this.conversationSummaryModel = config?.conversationSummaryModel ?? null;
    this.sandboxKey = null;
    this.createdAt = new Date();
    this.updatedAt = null;
  }

  createApiKey(name: string): { entity: ApiKey; rawKey: string } {
    const apiKey = new ApiKey(this, name);
    this.apiKeys.add(apiKey);
    return { entity: apiKey, rawKey: apiKey.rawKey };
  }

  enableConversations(tokenLimit: number, summaryModel?: string): void {
    this.conversationsEnabled = true;
    this.conversationTokenLimit = tokenLimit;
    this.conversationSummaryModel = summaryModel ?? null;
  }

  disableConversations(): void {
    this.conversationsEnabled = false;
  }

  resolveProviderConfig(tenantChain: Tenant[]): any {
    if (this.providerConfig) return this.providerConfig;
    for (const t of tenantChain) {
      if (t.providerConfig) return t.providerConfig;
    }
    return null;
  }
}
