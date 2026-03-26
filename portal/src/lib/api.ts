const API_BASE = '';  // same origin

export interface ApiError {
  error: string;
  details?: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
    if (!res.ok) throw new Error('Request failed');
    return {} as T;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
  return data as T;
}

export const api = {
  // Subtenants
  listSubtenants: (token: string) =>
    request<{ subtenants: Subtenant[] }>('GET', '/v1/portal/subtenants', undefined, token),

  createSubtenant: (token: string, name: string) =>
    request<{ subtenant: Subtenant }>('POST', '/v1/portal/subtenants', { name }, token),

  // Agents
  listAgents: (token: string) =>
    request<{ agents: Agent[] }>('GET', '/v1/portal/agents', undefined, token),

  createAgent: (token: string, data: CreateAgentInput) =>
    request<{ agent: Agent }>('POST', '/v1/portal/agents', data, token),

  getAgent: (token: string, id: string) =>
    request<{ agent: Agent }>('GET', `/v1/portal/agents/${id}`, undefined, token),

  updateAgent: (token: string, id: string, data: Partial<AgentInput>) =>
    request<{ agent: Agent }>('PUT', `/v1/portal/agents/${id}`, data, token),

  deleteAgent: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/agents/${id}`, undefined, token),

  getResolvedAgentConfig: (token: string, id: string) =>
    request<{ resolved: ResolvedAgentConfig }>('GET', `/v1/portal/agents/${id}/resolved`, undefined, token),

  sandboxChat: (
    token: string,
    agentId: string,
    messages: Array<{role: string; content: string}>,
    model?: string,
    conversationId?: string | null,
    partitionId?: string | null,
  ) =>
    request<{
      message: { role: string; content: string; reasoning_content?: string; reasoning?: string };
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      conversation_id?: string;
    }>(
      'POST', `/v1/portal/agents/${agentId}/chat`,
      {
        messages,
        model,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(partitionId ? { partition_id: partitionId } : {}),
      },
      token
    ),


  signup: (body: { tenantName?: string; email: string; password: string; inviteToken?: string }) =>
    request<{ token: string; user: User; tenant: Tenant; apiKey?: string; tenants?: TenantMembership[] }>('POST', '/v1/portal/auth/signup', body),

  login: (body: { email: string; password: string }) =>
    request<{ token: string; user: User; tenant: Tenant; tenants: TenantMembership[] }>('POST', '/v1/portal/auth/login', body),

  me: (token: string) =>
    request<{ user: User; tenant: TenantDetail; tenants: TenantMembership[] }>('GET', '/v1/portal/me', undefined, token),

  switchTenant: (token: string, body: { tenantId: string }) =>
    request<{ token: string; user: User; tenant: Tenant; tenants: TenantMembership[] }>('POST', '/v1/portal/auth/switch-tenant', body, token),

  updateSettings: (token: string, body: ProviderConfig & { availableModels?: string[] | null }) =>
    request<{ providerConfig: ProviderConfigSafe }>('PATCH', '/v1/portal/settings', body, token),

  updateOrgSettings: (token: string, body: { name?: string; orgSlug?: string }) =>
    request<{ name?: string; orgSlug?: string }>('PATCH', '/v1/portal/settings', body, token),

  listApiKeys: (token: string) =>
    request<{ apiKeys: ApiKeyEntry[] }>('GET', '/v1/portal/api-keys', undefined, token),

  createApiKey: (token: string, body: { name: string; agentId: string }) =>
    request<ApiKeyCreated>('POST', '/v1/portal/api-keys', body, token),

  revokeApiKey: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/api-keys/${id}`, undefined, token),

  // Invites
  getInviteInfo: (inviteToken: string) =>
    request<InviteInfo>('GET', `/v1/portal/invites/${inviteToken}/info`),

  listInvites: (token: string) =>
    request<{ invites: Invite[] }>('GET', '/v1/portal/invites', undefined, token),

  createInvite: (token: string, body: { maxUses?: number; expiresInHours?: number }) =>
    request<Invite>('POST', '/v1/portal/invites', body, token),

  revokeInvite: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/invites/${id}`, undefined, token),

  // Members
  listMembers: (token: string) =>
    request<{ members: Member[] }>('GET', '/v1/portal/members', undefined, token),

  updateMemberRole: (token: string, userId: string, body: { role: string }) =>
    request<Member>('PATCH', `/v1/portal/members/${userId}`, body, token),

  removeMember: (token: string, userId: string) =>
    request<void>('DELETE', `/v1/portal/members/${userId}`, undefined, token),

  // Partitions
  getPartitions: (token: string) =>
    request<{ partitions: Partition[] }>('GET', '/v1/portal/partitions', undefined, token),

  createPartition: (token: string, data: { external_id: string; parent_id?: string; title?: string }) =>
    request<{ partition: Partition }>('POST', '/v1/portal/partitions', data, token),

  updatePartition: (token: string, id: string, data: { title?: string; parent_id?: string }) =>
    request<{ partition: Partition }>('PATCH', `/v1/portal/partitions/${id}`, data, token),

  deletePartition: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/partitions/${id}`, undefined, token),

  // Knowledge Bases
  listKnowledgeBases: (token: string) =>
    request<{ knowledgeBases: KnowledgeBase[] }>('GET', '/v1/portal/knowledge-bases', undefined, token),

  getKnowledgeBase: (token: string, id: string) =>
    request<KnowledgeBase>('GET', `/v1/portal/knowledge-bases/${id}`, undefined, token),

  deleteKnowledgeBase: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/knowledge-bases/${id}`, undefined, token),

  createKnowledgeBase: async (token: string, name: string, files: File[]) => {
    const formData = new FormData();
    formData.append('name', name);
    for (const file of files) {
      formData.append('files', file);
    }
    const res = await fetch(`${API_BASE}/v1/portal/knowledge-bases`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create knowledge base');
    return data as { id: string; name: string; org: string; ref: string; chunkCount: number };
  },

  // Deployments
  listDeployments: (token: string) =>
    request<{ deployments: Deployment[] }>('GET', '/v1/portal/deployments', undefined, token),

  deleteDeployment: (token: string, id: string) =>
    request<void>('DELETE', `/v1/portal/deployments/${id}`, undefined, token),

  // Registry
  listArtifacts: (token: string, org: string) =>
    request<{ artifacts: ArtifactSummary[] }>('GET', `/v1/registry/list?org=${encodeURIComponent(org)}`, undefined, token),

  deployArtifact: (token: string, body: { org: string; name: string; tag: string; env: string }) =>
    request<{ deployment: Deployment }>('POST', '/v1/registry/deploy', body, token),

  // Embedder info
  getEmbedderInfo: (token: string) =>
    request<{ available: boolean; provider: string | null; model: string | null }>('GET', '/v1/portal/embedder-info', undefined, token),

  // Available providers
  getAvailableProviders: (token: string) =>
    request<{ providers: AvailableProvider[] }>('GET', '/v1/portal/available-providers', undefined, token),

  // Conversations
  getConversations: (token: string, partitionId?: string) => {
    const params = partitionId ? `?partition_id=${encodeURIComponent(partitionId)}` : '';
    return request<{ conversations: Conversation[] }>('GET', `/v1/portal/conversations${params}`, undefined, token);
  },

  getConversation: (token: string, id: string) =>
    request<{ conversation: ConversationDetail }>('GET', `/v1/portal/conversations/${id}`, undefined, token),
};

export interface User { id: string; email: string; role: string; }
export interface Tenant { id: string; name: string; }
export interface TenantDetail extends Tenant {
  orgSlug?: string | null;
  providerConfig: ProviderConfigSafe;
  availableModels?: string[] | null;
}
export interface TenantMembership { id: string; name: string; role: string; }
export interface ProviderConfig {
  provider: 'openai' | 'azure' | 'ollama';
  apiKey?: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
}
export interface ProviderConfigSafe {
  provider: string | null;
  baseUrl: string | null;
  deployment: string | null;
  apiVersion: string | null;
  hasApiKey: boolean;
}
export interface ApiKeyEntry {
  id: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
  agentId?: string;
  agentName?: string;
}
export interface ApiKeyCreated extends ApiKeyEntry { key: string; }
export interface InviteInfo {
  tenantName: string;
  expiresAt: string;
  isValid: boolean;
}
export interface Invite {
  id: string;
  token: string;
  inviteUrl: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdBy?: { id: string; email: string };
  isActive?: boolean;
}
export interface Member {
  id: string;
  email: string;
  role: string;
  joinedAt: string;
  lastLogin: string | null;
}
export interface Subtenant {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface AgentMergePolicies {
  system_prompt: 'prepend' | 'append' | 'overwrite' | 'ignore';
  skills: 'merge' | 'overwrite' | 'ignore';
  mcp_endpoints: 'merge' | 'overwrite' | 'ignore';
}

export interface Skill {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface McpEndpoint {
  name: string;
  url: string;
  auth?: string;
}

export interface Agent {
  id: string;
  name: string;
  providerConfig?: Record<string, unknown> | null;
  systemPrompt?: string | null;
  skills?: Skill[] | null;
  mcpEndpoints?: McpEndpoint[] | null;
  availableModels?: string[] | null;
  mergePolicies: AgentMergePolicies;
  conversations_enabled?: boolean;
  conversation_token_limit?: number | null;
  conversation_summary_model?: string | null;
  knowledgeBaseRef?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface AgentInput {
  name: string;
  providerConfig?: Record<string, unknown> | null;
  systemPrompt?: string | null;
  skills?: Skill[] | null;
  mcpEndpoints?: McpEndpoint[] | null;
  availableModels?: string[] | null;
  mergePolicies?: AgentMergePolicies;
  conversationsEnabled?: boolean;
  conversationTokenLimit?: number | null;
  conversationSummaryModel?: string | null;
  knowledgeBaseRef?: string | null;
}

export interface KnowledgeBase {
  id: string;
  org: string;
  name: string;
  version: string;
  createdAt: string;
  chunkCount: number;
  vectorSpace: string;
}

export interface Deployment {
  id: string;
  artifactId: string;
  env: string;
  status: string;
  deployedAt: string;
  artifact: {
    org: string;
    name: string;
    version: string;
  };
}

export interface ArtifactSummary {
  org: string;
  name: string;
  version: string;
  kind: string;
  createdAt: string;
}

export type CreateAgentInput = AgentInput;

export interface Partition {
  id: string;
  external_id: string;
  title?: string;
  parent_id?: string;
  created_at: string;
  children?: Partition[];
}

export interface Conversation {
  id: string;
  external_id: string;
  partition_id?: string;
  agent_id?: string;
  created_at: string;
  last_active_at: string;
  message_count?: number;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  token_estimate?: number;
  created_at: string;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
  snapshots?: { id: string; messages_archived: number; created_at: string }[];
}

export interface AvailableProvider {
  id: string;
  name: string;
  type: 'openai' | 'azure' | 'ollama';
  availableModels: string[];
  baseUrl?: string | null;
}

export interface ResolvedAgentConfig {
  providerConfig: Record<string, unknown> | null;
  systemPrompt: string | null;
  skills: Skill[];
  mcpEndpoints: McpEndpoint[];
  mergePolicies: AgentMergePolicies;
  inheritanceChain: Array<{ level: 'agent' | 'tenant'; name: string; id: string }>;
}
