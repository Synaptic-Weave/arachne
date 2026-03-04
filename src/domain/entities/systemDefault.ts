import { User } from './User.js';
import { Tenant } from './Tenant.js';
import { Agent } from './Agent.js';

// Create a system default user, tenant, and agent
export function createSystemDefaultAgent(): Agent {
  // System user (owner)
  const systemUser = new User('system@localhost', '');
  // System tenant
  const systemTenant = new Tenant(systemUser, 'System Tenant');
  // System agent
  const systemAgent = systemTenant.createAgent('system-default', {
    kind: 'inference',
    systemPrompt: 'Default system agent',
    providerConfig: null,
    skills: [],
    mcpEndpoints: [],
    availableModels: [],
    knowledgeBaseRef: null,
    conversationsEnabled: false,
    conversationTokenLimit: 4000,
    conversationSummaryModel: null,
  });
  return systemAgent;
}
