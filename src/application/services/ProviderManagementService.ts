import type { EntityManager } from '@mikro-orm/core';
import { ProviderBase } from '../../domain/entities/ProviderBase.js';
import { OpenAIProvider } from '../../domain/entities/OpenAIProvider.js';
import { AzureProvider } from '../../domain/entities/AzureProvider.js';
import { OllamaProvider } from '../../domain/entities/OllamaProvider.js';
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
}
