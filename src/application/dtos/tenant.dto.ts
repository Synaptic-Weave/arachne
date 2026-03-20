export interface TenantViewModel {
  id: string;
  name: string;
  status: string;
  defaultProviderId: string | null;
  providerConfig: any;
  systemPrompt: string | null;
  skills: any[] | null;
  mcpEndpoints: any[] | null;
  availableModels: any[] | null;
  createdAt: string;
}

export interface MemberViewModel {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface InviteViewModel {
  id: string;
  token: string;
  tenantId: string;
  maxUses: number | null;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateInviteDto {
  maxUses?: number;
  expiresInDays?: number;
}

export interface UpdateTenantDto {
  name?: string;
  orgSlug?: string;
  providerConfig?: any;
  systemPrompt?: string | null;
  skills?: any[] | null;
  mcpEndpoints?: any[] | null;
  availableModels?: any[] | null;
  status?: string;
}

export interface CreateSubtenantDto {
  name: string;
  createdByUserId: string;
}
