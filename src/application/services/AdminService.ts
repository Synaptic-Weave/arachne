/**
 * AdminService — encapsulates all database access for admin routes.
 * Route handlers stay thin: parse HTTP → call AdminService → return DTO.
 */
import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { EntityManager } from '@mikro-orm/core';
import { Tenant } from '../../domain/entities/Tenant.js';
import { ApiKey } from '../../domain/entities/ApiKey.js';
import { Trace } from '../../domain/entities/Trace.js';
import { AdminUser } from '../../domain/entities/AdminUser.js';
import { BetaSignup } from '../../domain/entities/BetaSignup.js';
import { Settings } from '../../domain/entities/Settings.js';

const scryptAsync = promisify(scrypt);

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(key, 'hex'), derivedKey);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

export interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TenantDetailRow extends TenantRow {
  provider_config: any;
  api_key_count: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TraceRow {
  id: string;
  tenant_id: string;
  model: string;
  provider: string;
  status_code: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  ttfb_ms: number;
  gateway_overhead_ms: number;
  created_at: Date;
}

export interface ListTenantsFilters {
  limit: number;
  offset: number;
  status?: string;
}

export interface ListTracesFilters {
  limit: number;
  tenant_id?: string;
  cursor?: string;
}

export interface BetaSignupRow {
  id: string;
  email: string;
  name: string | null;
  inviteCode: string | null;
  approvedAt: string | null;
  approvedByAdminId: string | null;
  inviteUsedAt: string | null;
  createdAt: string;
  status: 'pending' | 'approved' | 'used';
}

export interface SettingsRow {
  signupsEnabled: boolean;
  defaultEmbedderProvider: string | null;
  defaultEmbedderModel: string | null;
  defaultEmbedderApiKey: string | null;
  defaultEmbedderProviderId: string | null;
  updatedAt: string;
  updatedByAdminId: string | null;
}

export class AdminService {
  constructor(private readonly em: EntityManager) {}

  // ── Auth ──────────────────────────────────────────────────────────────────

  async validateAdminLogin(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; mustChangePassword: boolean } | null> {
    const adminUser = await this.em.getRepository(AdminUser).findOne({ username });
    if (!adminUser) return null;
    const isValid = await verifyPassword(password, adminUser.passwordHash);
    if (!isValid) return null;

    return { id: adminUser.id, username: adminUser.username, mustChangePassword: adminUser.mustChangePassword };
  }

  async updateAdminLastLogin(id: string): Promise<void> {
    await this.em.getRepository(AdminUser).nativeUpdate({ id }, { lastLogin: new Date() });
  }

  async changeAdminPassword(id: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const adminUser = await this.em.getRepository(AdminUser).findOne({ id });
    if (!adminUser) {
      return { success: false, error: 'admin_not_found' };
    }
    const isValid = await verifyPassword(currentPassword, adminUser.passwordHash);
    if (!isValid) {
      return { success: false, error: 'invalid_current_password' };
    }
    const newHash = await hashPassword(newPassword);
    adminUser.passwordHash = newHash;
    adminUser.mustChangePassword = false;
    await this.em.persistAndFlush(adminUser);
    return { success: true };
  }

  async forceChangeAdminPassword(id: string, newPassword: string): Promise<void> {
    const adminUser = await this.em.getRepository(AdminUser).findOne({ id });
    if (!adminUser) return;
    const newHash = await hashPassword(newPassword);
    adminUser.passwordHash = newHash;
    adminUser.mustChangePassword = false;
    await this.em.persistAndFlush(adminUser);
  }

  // ── Tenants ───────────────────────────────────────────────────────────────

  async createTenant(name: string): Promise<TenantRow> {
    const tenant = new Tenant(name);
    this.em.persist(tenant);
    await this.em.flush();
    return {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      created_at: tenant.createdAt.toISOString(),
      updated_at: tenant.updatedAt.toISOString(),
    };
  }

  async listTenants(
    filters: ListTenantsFilters,
  ): Promise<{ tenants: TenantRow[]; total: number }> {
    const { limit, offset, status } = filters;

    const repo = this.em.getRepository(Tenant);
    const where: any = {};
    if (status) where.status = status;
    const [tenants, total] = await Promise.all([
      repo.find(where, { orderBy: { createdAt: 'DESC' }, limit, offset }),
      repo.count(where),
    ]);
    return {
      tenants: tenants.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        created_at: t.createdAt.toISOString(),
        updated_at: (t.updatedAt ?? t.createdAt).toISOString(),
      })),
      total,
    };
  }

  async getTenant(id: string): Promise<TenantDetailRow | null> {
    const repo = this.em.getRepository(Tenant);
    const tenant = await repo.findOne({ id });
    if (!tenant) return null;
    const apiKeyRepo = this.em.getRepository(ApiKey);
    const apiKeyCount = await apiKeyRepo.count({ tenant: tenant });
    return {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      created_at: tenant.createdAt.toISOString(),
      updated_at: (tenant.updatedAt ?? tenant.createdAt).toISOString(),
      provider_config: tenant.providerConfig,
      api_key_count: String(apiKeyCount),
    };
  }

  async updateTenant(
    id: string,
    fields: { name?: string; status?: string },
  ): Promise<TenantRow | null> {
    const repo = this.em.getRepository(Tenant);
    const tenant = await repo.findOne({ id });
    if (!tenant) return null;
    if (fields.name) tenant.name = fields.name.trim();
    if (fields.status) tenant.status = fields.status;
    tenant.updatedAt = new Date();
    await this.em.persistAndFlush(tenant);
    return {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      created_at: tenant.createdAt.toISOString(),
      updated_at: (tenant.updatedAt ?? tenant.createdAt).toISOString(),
    };
  }

  async deleteTenant(id: string): Promise<boolean> {
    const repo = this.em.getRepository(Tenant);
    const tenant = await repo.findOne({ id });
    if (!tenant) return false;
    await this.em.removeAndFlush(tenant);
    return true;
  }

  // ── Provider config ────────────────────────────────────────────────────────

  async tenantExists(id: string): Promise<boolean> {
    const repo = this.em.getRepository(Tenant);
    return !!(await repo.findOne({ id }));
  }

  async setProviderConfig(id: string, providerConfig: object): Promise<void> {
    const repo = this.em.getRepository(Tenant);
    const tenant = await repo.findOne({ id });
    if (!tenant) return;
    tenant.providerConfig = providerConfig;
    tenant.updatedAt = new Date();
    await this.em.persistAndFlush(tenant);
  }

  async clearProviderConfig(id: string): Promise<boolean> {
    const repo = this.em.getRepository(Tenant);
    const tenant = await repo.findOne({ id });
    if (!tenant) return false;
    tenant.providerConfig = null;
    tenant.updatedAt = new Date();
    await this.em.persistAndFlush(tenant);
    return true;
  }

  // ── API keys ───────────────────────────────────────────────────────────────

  async createApiKey(
    tenantId: string,
    name: string,
    rawKey: string,
    keyPrefix: string,
    keyHash: string,
  ): Promise<{ id: string; name: string; key_prefix: string; status: string; created_at: string }> {
    const repo = this.em.getRepository(ApiKey);
    const tenant = await this.em.getRepository(Tenant).findOne({ id: tenantId }, { populate: ['agents'] });
    if (!tenant) throw new Error('Tenant not found');
    // Find the Default agent for this tenant
    const agent = tenant.agents.getItems().find(a => a.name === 'Default');
    if (!agent) throw new Error('Default agent not found for tenant');
    const now = new Date();
    const apiKey = repo.create({
      tenant,
      agent,
      name,
      keyPrefix,
      keyHash,
      status: 'active',
      createdAt: now,
      rawKey,
      expiresAt: null,
      rotatedFromId: null,
    });
    await this.em.persistAndFlush(apiKey);
    return {
      id: apiKey.id,
      name: apiKey.name,
      key_prefix: apiKey.keyPrefix,
      status: apiKey.status,
      created_at: apiKey.createdAt.toISOString(),
    };
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
    const repo = this.em.getRepository(ApiKey);
    const tenant = await this.em.getRepository(Tenant).findOne({ id: tenantId });
    if (!tenant) return [];
    const apiKeys = await repo.find({ tenant }, { orderBy: { createdAt: 'DESC' } });
    return apiKeys.map(k => ({
      id: k.id,
      name: k.name,
      key_prefix: k.keyPrefix,
      status: k.status,
      created_at: k.createdAt.toISOString(),
      revoked_at: k.revokedAt ? k.revokedAt.toISOString() : null,
    }));
  }

  async getApiKeyHash(keyId: string, tenantId: string): Promise<string | null> {
    const repo = this.em.getRepository(ApiKey);
    const tenant = await this.em.getRepository(Tenant).findOne({ id: tenantId });
    if (!tenant) return null;
    const apiKey = await repo.findOne({ id: keyId, tenant });
    return apiKey?.keyHash ?? null;
  }

  async hardDeleteApiKey(keyId: string, tenantId: string): Promise<void> {
    const repo = this.em.getRepository(ApiKey);
    const tenant = await this.em.getRepository(Tenant).findOne({ id: tenantId });
    if (!tenant) return;
    const apiKey = await repo.findOne({ id: keyId, tenant });
    if (apiKey) await this.em.removeAndFlush(apiKey);
  }

  async revokeApiKey(keyId: string, tenantId: string): Promise<string | null> {
    const repo = this.em.getRepository(ApiKey);
    const tenant = await this.em.getRepository(Tenant).findOne({ id: tenantId });
    if (!tenant) return null;
    const apiKey = await repo.findOne({ id: keyId, tenant });
    if (!apiKey) return null;
    apiKey.status = 'revoked';
    apiKey.revokedAt = new Date();
    await this.em.persistAndFlush(apiKey);
    return apiKey.keyHash;
  }

  // ── Traces ─────────────────────────────────────────────────────────────────

  async listTraces(filters: ListTracesFilters): Promise<TraceRow[]> {
    const { limit, tenant_id, cursor } = filters;
    const repo = this.em.getRepository(Trace);
    const where: any = {};
    if (tenant_id) {
      const tenant = await this.em.getRepository(Tenant).findOne({ id: tenant_id });
      if (tenant) where.tenant = tenant;
    }
    if (cursor) where.createdAt = { $lt: new Date(cursor) };
    const traces = await repo.find(where, { orderBy: { createdAt: 'DESC' }, limit });
    return traces.map(t => ({
      id: t.id,
      tenant_id: t.tenant?.id ?? '',
      model: t.model,
      provider: t.provider,
      status_code: t.statusCode ?? 0,
      latency_ms: t.latencyMs ?? 0,
      prompt_tokens: t.promptTokens ?? 0,
      completion_tokens: t.completionTokens ?? 0,
      ttfb_ms: t.ttfbMs ?? 0,
      gateway_overhead_ms: t.gatewayOverheadMs ?? 0,
      created_at: t.createdAt,
    }));
  }

  // ── Beta Signups ───────────────────────────────────────────────────────────

  async listBetaSignups(): Promise<BetaSignupRow[]> {
    const repo = this.em.getRepository(BetaSignup);
    const signups = await repo.find({}, { orderBy: { createdAt: 'DESC' } });
    return signups.map(s => {
      let status: 'pending' | 'approved' | 'used';
      if (s.inviteUsedAt) {
        status = 'used';
      } else if (s.approvedAt) {
        status = 'approved';
      } else {
        status = 'pending';
      }
      return {
        id: s.id,
        email: s.email,
        name: s.name,
        inviteCode: s.inviteCode,
        approvedAt: s.approvedAt ? s.approvedAt.toISOString() : null,
        approvedByAdminId: s.approvedByAdminId,
        inviteUsedAt: s.inviteUsedAt ? s.inviteUsedAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
        status,
      };
    });
  }

  async approveBetaSignup(signupId: string, adminId: string): Promise<BetaSignupRow | null> {
    const repo = this.em.getRepository(BetaSignup);
    const signup = await repo.findOne({ id: signupId });
    if (!signup) return null;

    // Use the domain method to approve
    signup.approve(adminId);
    await this.em.persistAndFlush(signup);

    return {
      id: signup.id,
      email: signup.email,
      name: signup.name,
      inviteCode: signup.inviteCode,
      approvedAt: signup.approvedAt ? signup.approvedAt.toISOString() : null,
      approvedByAdminId: signup.approvedByAdminId,
      inviteUsedAt: signup.inviteUsedAt ? signup.inviteUsedAt.toISOString() : null,
      createdAt: signup.createdAt.toISOString(),
      status: 'approved',
    };
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getSettings(): Promise<SettingsRow> {
    const repo = this.em.getRepository(Settings);
    let settings = await repo.findOne({ id: 1 });

    // If settings don't exist, create them with defaults
    if (!settings) {
      settings = new Settings();
      // Initialize from environment variable if set
      if (process.env.SIGNUPS_ENABLED === 'false') {
        settings.signupsEnabled = false;
      }
      await this.em.persistAndFlush(settings);
    }

    return {
      signupsEnabled: settings.signupsEnabled,
      defaultEmbedderProvider: settings.defaultEmbedderProvider,
      defaultEmbedderModel: settings.defaultEmbedderModel,
      defaultEmbedderApiKey: settings.defaultEmbedderApiKey ? '••••••••' : null,
      defaultEmbedderProviderId: settings.defaultEmbedderProviderId,
      updatedAt: settings.updatedAt.toISOString(),
      updatedByAdminId: settings.updatedByAdminId,
    };
  }

  async updateSettings(
    updates: {
      signupsEnabled?: boolean;
      defaultEmbedderProvider?: string | null;
      defaultEmbedderModel?: string | null;
      defaultEmbedderApiKey?: string | null;
      defaultEmbedderProviderId?: string | null;
    },
    adminId: string,
  ): Promise<SettingsRow> {
    const repo = this.em.getRepository(Settings);
    let settings = await repo.findOne({ id: 1 });

    if (!settings) {
      settings = new Settings();
    }

    if (updates.signupsEnabled !== undefined) {
      settings.updateSignupsEnabled(updates.signupsEnabled, adminId);
    }

    // New path: provider reference (clears legacy fields)
    if (updates.defaultEmbedderProviderId !== undefined) {
      settings.updateEmbedderProviderRef(
        updates.defaultEmbedderProviderId,
        updates.defaultEmbedderModel ?? settings.defaultEmbedderModel,
        adminId,
      );
    } else if (
      updates.defaultEmbedderProvider !== undefined ||
      updates.defaultEmbedderModel !== undefined ||
      updates.defaultEmbedderApiKey !== undefined
    ) {
      // Legacy path: standalone fields
      settings.updateEmbedderConfig(
        updates.defaultEmbedderProvider ?? settings.defaultEmbedderProvider,
        updates.defaultEmbedderModel ?? settings.defaultEmbedderModel,
        updates.defaultEmbedderApiKey ?? settings.defaultEmbedderApiKey,
        adminId,
      );
    }

    await this.em.persistAndFlush(settings);

    return {
      signupsEnabled: settings.signupsEnabled,
      defaultEmbedderProvider: settings.defaultEmbedderProvider,
      defaultEmbedderModel: settings.defaultEmbedderModel,
      defaultEmbedderApiKey: settings.defaultEmbedderApiKey ? '••••••••' : null,
      defaultEmbedderProviderId: settings.defaultEmbedderProviderId,
      updatedAt: settings.updatedAt.toISOString(),
      updatedByAdminId: settings.updatedByAdminId,
    };
  }

  async isSignupsEnabled(): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.signupsEnabled;
  }
}
