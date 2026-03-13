export interface CreateUserDto {
  email: string;
  password: string;
  tenantName?: string;
  inviteToken?: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AcceptInviteDto {
  inviteToken: string;
  email: string;
  password: string;
  tenantName?: string;
}

export interface AuthResult {
  token: string;
  userId: string;
  tenantId: string;
  email: string;
  tenantName: string;
  tenants?: Array<{ id: string; name: string; role: string }>;
}
