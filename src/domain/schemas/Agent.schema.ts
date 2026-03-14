import { EntitySchema } from '@mikro-orm/core';
import { Agent } from '../entities/Agent.js';
import { Tenant } from '../entities/Tenant.js';
import { ApiKey } from '../entities/ApiKey.js';

export const AgentSchema = new EntitySchema<Agent>({
  class: Agent,
  tableName: 'agents',
  properties: {
    id: { type: 'uuid', primary: true },
    tenant: { kind: 'm:1', entity: () => Tenant, fieldName: 'tenant_id' },
    name: { type: 'string', columnType: 'varchar(255)' },
    kind: { type: 'string', columnType: 'varchar(50)', default: 'inference' },
    providerConfig: { type: 'json', fieldName: 'provider_config', nullable: true },
    systemPrompt: { type: 'text', fieldName: 'system_prompt', nullable: true },
    skills: { type: 'json', nullable: true },
    mcpEndpoints: { type: 'json', fieldName: 'mcp_endpoints', nullable: true },
    mergePolicies: { type: 'json', fieldName: 'merge_policies' },
    availableModels: { type: 'json', fieldName: 'available_models', nullable: true },
    knowledgeBaseRef: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'knowledge_base_ref',
      nullable: true,
    },
    conversationsEnabled: {
      type: 'boolean',
      fieldName: 'conversations_enabled',
      default: false,
    },
    conversationTokenLimit: {
      type: 'integer',
      fieldName: 'conversation_token_limit',
      default: 4000,
    },
    conversationSummaryModel: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'conversation_summary_model',
      nullable: true,
    },
    sandboxKey: { type: 'text', fieldName: 'sandbox_key', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    updatedAt: { type: 'Date', fieldName: 'updated_at', nullable: true, onUpdate: () => new Date() },
    apiKeys: { kind: '1:m', entity: () => ApiKey, mappedBy: 'agent', eager: false },
  },
});
