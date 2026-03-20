import { EntitySchema, Cascade } from '@mikro-orm/core';
import { Tenant } from '../entities/Tenant.js';
import { Agent } from '../entities/Agent.js';
import { TenantMembership } from '../entities/TenantMembership.js';
import { Invite } from '../entities/Invite.js';

export const TenantSchema = new EntitySchema<Tenant>({
  class: Tenant,
  tableName: 'tenants',
  properties: {
    id: { type: 'uuid', primary: true },
    name: { type: 'string', columnType: 'varchar(255)' },
    orgSlug: { type: 'string', columnType: 'varchar(100)', fieldName: 'org_slug' },
    parentId: { type: 'uuid', fieldName: 'parent_id', nullable: true },
    providerConfig: { type: 'json', fieldName: 'provider_config', nullable: true },
    systemPrompt: { type: 'text', fieldName: 'system_prompt', nullable: true },
    skills: { type: 'json', nullable: true },
    mcpEndpoints: { type: 'json', fieldName: 'mcp_endpoints', nullable: true },
    defaultProviderId: { type: 'uuid', fieldName: 'default_provider_id', nullable: true },
    status: { type: 'string', columnType: 'varchar(20)', default: 'active' },
    availableModels: { type: 'json', fieldName: 'available_models', nullable: true },
    updatedAt: { type: 'Date', fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    agents: { kind: '1:m', entity: () => Agent, mappedBy: 'tenant', eager: false, cascade: [Cascade.PERSIST] },
    members: { kind: '1:m', entity: () => TenantMembership, mappedBy: 'tenant', eager: false, cascade: [Cascade.PERSIST] },
    invites: { kind: '1:m', entity: () => Invite, mappedBy: 'tenant', eager: false, cascade: [Cascade.PERSIST] },
  },
});
