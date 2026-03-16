export interface AgentViewModel {
  id: string;
  tenantId: string;
  name: string;
  providerConfig: any;
  systemPrompt: string | null;
  skills: any[] | null;
  mcpEndpoints: any[] | null;
  mergePolicies: any;
  availableModels: any[] | null;
  conversationsEnabled: boolean;
  conversationTokenLimit: number;
  conversationSummaryModel: string | null;
  knowledgeBaseRef: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateAgentDto {
  name: string;
  providerConfig?: any;
  systemPrompt?: string | null;
  skills?: any[] | null;
  mcpEndpoints?: any[] | null;
  mergePolicies?: any;
  availableModels?: any[] | null;
  conversationsEnabled?: boolean;
  conversationTokenLimit?: number;
  conversationSummaryModel?: string | null;
  knowledgeBaseRef?: string | null;
}

export interface UpdateAgentDto {
  name?: string;
  providerConfig?: any;
  systemPrompt?: string | null;
  skills?: any[] | null;
  mcpEndpoints?: any[] | null;
  mergePolicies?: any;
  availableModels?: any[] | null;
  conversationsEnabled?: boolean;
  conversationTokenLimit?: number;
  conversationSummaryModel?: string | null;
  knowledgeBaseRef?: string | null;
}

export interface ApiKeyViewModel {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string;
  agentId: string;
  agentName: string;
  expiresAt: string | null;
  rotatedFromId: string | null;
}

export interface ApiKeyCreatedViewModel extends ApiKeyViewModel {
  rawKey: string;
}

export interface ApiKeyRotatedViewModel extends ApiKeyCreatedViewModel {
  oldKeyHash: string;
}

export interface CreateApiKeyDto {
  name?: string;
  expiresAt?: string;
}
