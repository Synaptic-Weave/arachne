import type { EntityManager } from '@mikro-orm/core';
import { ProviderBase } from '../../domain/entities/ProviderBase.js';
import { OpenAIProvider } from '../../domain/entities/OpenAIProvider.js';
import { AzureProvider } from '../../domain/entities/AzureProvider.js';
import { OllamaProvider } from '../../domain/entities/OllamaProvider.js';
import { ProviderTenantAccess } from '../../domain/entities/ProviderTenantAccess.js';
import { Tenant } from '../../domain/entities/Tenant.js';
import { Agent } from '../../domain/entities/Agent.js';
import type { CreateProviderDto, UpdateProviderDto, ProviderViewModel } from '../dtos/provider.dto.js';
import { toProviderViewModel } from '../dtos/provider.dto.js';

export class ProviderManagementService {
  constructor(private readonly em: EntityManager) {}

  /**
   * List all gateway providers (admin view with secrets)
   */
  async listGatewayProviders(): Promise<ProviderViewModel[]> {
    const providers = await this.em.find(ProviderBase, { tenant: null });
    return providers.map(p => toProviderViewModel(p, true));
  }

  /**
   * Get a single gateway provider by ID
   */
  async getGatewayProvider(id: string): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });
    return toProviderViewModel(provider, true);
  }

  /**
   * Create a gateway provider
   */
  async createGatewayProvider(dto: CreateProviderDto): Promise<ProviderViewModel> {
    let provider: ProviderBase;

    switch (dto.type) {
      case 'openai': {
        provider = new OpenAIProvider(dto.name, dto.apiKey, {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as OpenAIProvider).baseUrl = dto.baseUrl ?? null;
        break;
      }

      case 'azure': {
        if (!dto.deployment) {
          throw Object.assign(new Error('deployment is required for Azure provider'), { status: 400 });
        }
        if (!dto.apiVersion) {
          throw Object.assign(new Error('apiVersion is required for Azure provider'), { status: 400 });
        }

        provider = new AzureProvider(dto.name, dto.apiKey, {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as AzureProvider).baseUrl = dto.baseUrl ?? null;
        (provider as AzureProvider).deployment = dto.deployment;
        (provider as AzureProvider).apiVersion = dto.apiVersion;
        break;
      }

      case 'ollama': {
        if (!dto.baseUrl) {
          throw Object.assign(new Error('baseUrl is required for Ollama provider'), { status: 400 });
        }

        provider = new OllamaProvider(dto.name, dto.apiKey || 'ollama', {
          description: dto.description,
          availableModels: dto.availableModels,
        });
        (provider as OllamaProvider).baseUrl = dto.baseUrl;
        break;
      }

      default:
        throw Object.assign(new Error(`Unknown provider type: ${dto.type}`), { status: 400 });
    }

    provider.validate();
    this.em.persist(provider);
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Update a gateway provider
   */
  async updateGatewayProvider(id: string, dto: UpdateProviderDto): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.description !== undefined) provider.description = dto.description;
    if (dto.apiKey !== undefined) provider.apiKey = dto.apiKey;
    if (dto.availableModels !== undefined) provider.availableModels = dto.availableModels;

    // Type-specific updates
    if ('baseUrl' in provider && dto.baseUrl !== undefined) {
      (provider as any).baseUrl = dto.baseUrl;
    }
    if ('deployment' in provider && dto.deployment !== undefined) {
      (provider as any).deployment = dto.deployment;
    }
    if ('apiVersion' in provider && dto.apiVersion !== undefined) {
      (provider as any).apiVersion = dto.apiVersion;
    }

    provider.updatedAt = new Date();
    provider.validate();
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Delete a gateway provider (checks if in use)
   */
  async deleteGatewayProvider(id: string): Promise<void> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    // TODO: Check if provider is in use by any agents when Agent.providerId is added
    // const agentCount = await this.em.count(Agent, { provider: id });
    // if (agentCount > 0) {
    //   throw Object.assign(new Error('Provider is in use by agents'), { status: 400 });
    // }

    await this.em.removeAndFlush(provider);
  }

  /**
   * Set a gateway provider as default (unsets others)
   */
  async setGatewayDefault(id: string): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id, tenant: null });

    // Unset all other defaults
    const currentDefaults = await this.em.find(ProviderBase, { tenant: null, isDefault: true });
    for (const p of currentDefaults) {
      if (p.id !== id) {
        p.isDefault = false;
      }
    }

    provider.isDefault = true;
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  // ── Tenant Availability ────────────────────────────────────────────────────

  /**
   * Toggle gateway-wide tenant availability
   */
  async updateTenantAvailability(providerId: string, tenantAvailable: boolean): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id: providerId, tenant: null });
    provider.tenantAvailable = tenantAvailable;
    provider.updatedAt = new Date();
    await this.em.flush();
    return toProviderViewModel(provider, true);
  }

  /**
   * Grant per-tenant access to a gateway provider
   */
  async grantTenantAccess(providerId: string, tenantId: string): Promise<void> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id: providerId, tenant: null });
    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId });

    // Check if already exists
    const existing = await this.em.findOne(ProviderTenantAccess, {
      provider: providerId,
      tenant: tenantId,
    });
    if (existing) {
      throw Object.assign(new Error('Tenant already has access to this provider'), { status: 400 });
    }

    const access = new ProviderTenantAccess(provider, tenant);
    this.em.persist(access);
    await this.em.flush();
  }

  /**
   * Revoke per-tenant access to a gateway provider
   */
  async revokeTenantAccess(providerId: string, tenantId: string): Promise<void> {
    const access = await this.em.findOneOrFail(ProviderTenantAccess, {
      provider: providerId,
      tenant: tenantId,
    });
    await this.em.removeAndFlush(access);
  }

  /**
   * List tenants with specific access to a gateway provider
   */
  async listProviderTenantAccess(providerId: string): Promise<Array<{ id: string; name: string; createdAt: string }>> {
    await this.em.findOneOrFail(ProviderBase, { id: providerId, tenant: null });
    const accesses = await this.em.find(
      ProviderTenantAccess,
      { provider: providerId },
      { populate: ['tenant'] },
    );
    return accesses.map(a => ({
      id: a.tenant.id,
      name: a.tenant.name,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  /**
   * List gateway providers available to a specific tenant.
   * A provider is available if tenantAvailable=true OR it has a specific access row.
   */
  async listAvailableProvidersForTenant(tenantId: string): Promise<ProviderViewModel[]> {
    // Get all gateway providers available to all tenants
    const globalProviders = await this.em.find(ProviderBase, {
      tenant: null,
      tenantAvailable: true,
    });

    // Get providers with specific access grants
    const accesses = await this.em.find(
      ProviderTenantAccess,
      { tenant: tenantId },
      { populate: ['provider'] },
    );

    // Merge, dedup by ID
    const seen = new Set<string>();
    const result: ProviderViewModel[] = [];

    for (const p of globalProviders) {
      seen.add(p.id);
      result.push(toProviderViewModel(p, false));
    }

    for (const a of accesses) {
      if (!seen.has(a.provider.id)) {
        seen.add(a.provider.id);
        result.push(toProviderViewModel(a.provider, false));
      }
    }

    return result;
  }

  // ── Tenant Custom Provider Management (BYOK) ──────────────────────────────

  /**
   * List providers owned by a specific tenant (custom/BYOK providers)
   */
  async listTenantProviders(tenantId: string): Promise<ProviderViewModel[]> {
    const providers = await this.em.find(ProviderBase, { tenant: tenantId });
    return providers.map(p => toProviderViewModel(p, true));
  }

  /**
   * Create a tenant-owned provider (BYOK)
   */
  async createTenantProvider(tenantId: string, dto: CreateProviderDto): Promise<ProviderViewModel> {
    // Check for duplicate name within this tenant
    const existing = await this.em.findOne(ProviderBase, { tenant: tenantId, name: dto.name });
    if (existing) {
      throw Object.assign(new Error(`Provider with name "${dto.name}" already exists for this tenant`), { status: 409 });
    }

    const tenant = await this.em.findOneOrFail(Tenant, { id: tenantId });

    let provider: ProviderBase;

    switch (dto.type) {
      case 'openai': {
        provider = new OpenAIProvider(dto.name, dto.apiKey, {
          description: dto.description,
          tenant,
          availableModels: dto.availableModels,
        });
        (provider as OpenAIProvider).baseUrl = dto.baseUrl ?? null;
        break;
      }

      case 'azure': {
        if (!dto.deployment) {
          throw Object.assign(new Error('deployment is required for Azure provider'), { status: 400 });
        }
        if (!dto.apiVersion) {
          throw Object.assign(new Error('apiVersion is required for Azure provider'), { status: 400 });
        }

        provider = new AzureProvider(dto.name, dto.apiKey, {
          description: dto.description,
          tenant,
          availableModels: dto.availableModels,
        });
        (provider as AzureProvider).baseUrl = dto.baseUrl ?? null;
        (provider as AzureProvider).deployment = dto.deployment;
        (provider as AzureProvider).apiVersion = dto.apiVersion;
        break;
      }

      case 'ollama': {
        if (!dto.baseUrl) {
          throw Object.assign(new Error('baseUrl is required for Ollama provider'), { status: 400 });
        }

        provider = new OllamaProvider(dto.name, dto.apiKey || 'ollama', {
          description: dto.description,
          tenant,
          availableModels: dto.availableModels,
        });
        (provider as OllamaProvider).baseUrl = dto.baseUrl;
        break;
      }

      default:
        throw Object.assign(new Error(`Unknown provider type: ${dto.type}`), { status: 400 });
    }

    provider.validate();
    this.em.persist(provider);
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Update a tenant-owned provider
   */
  async updateTenantProvider(tenantId: string, providerId: string, dto: UpdateProviderDto): Promise<ProviderViewModel> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id: providerId, tenant: tenantId });

    if (dto.name !== undefined) provider.name = dto.name;
    if (dto.description !== undefined) provider.description = dto.description;
    if (dto.apiKey !== undefined) provider.apiKey = dto.apiKey;
    if (dto.availableModels !== undefined) provider.availableModels = dto.availableModels;

    // Type-specific updates
    if ('baseUrl' in provider && dto.baseUrl !== undefined) {
      (provider as any).baseUrl = dto.baseUrl;
    }
    if ('deployment' in provider && dto.deployment !== undefined) {
      (provider as any).deployment = dto.deployment;
    }
    if ('apiVersion' in provider && dto.apiVersion !== undefined) {
      (provider as any).apiVersion = dto.apiVersion;
    }

    provider.updatedAt = new Date();
    provider.validate();
    await this.em.flush();

    return toProviderViewModel(provider, true);
  }

  /**
   * Delete a tenant-owned provider.
   * Throws 409 if any agents reference this provider via providerId.
   */
  async deleteTenantProvider(tenantId: string, providerId: string): Promise<void> {
    const provider = await this.em.findOneOrFail(ProviderBase, { id: providerId, tenant: tenantId });

    // Check if any agents reference this provider
    const agentCount = await this.em.count(Agent, { providerId });
    if (agentCount > 0) {
      throw Object.assign(
        new Error(`Provider is referenced by ${agentCount} agent(s). Remove the references before deleting.`),
        { status: 409 },
      );
    }

    await this.em.removeAndFlush(provider);
  }
}
