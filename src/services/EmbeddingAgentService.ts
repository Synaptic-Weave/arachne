import type { EntityManager } from '@mikro-orm/core';
import { Agent } from '../domain/entities/Agent.js';
import { Tenant } from '../domain/entities/Tenant.js';
import { Settings } from '../domain/entities/Settings.js';
import { ProviderBase } from '../domain/entities/ProviderBase.js';

export interface EmbeddingAgentConfig {
  provider: string;       // e.g., 'openai'
  model: string;          // e.g., 'text-embedding-3-small'
  dimensions: number;     // e.g., 1536
  apiKey?: string;        // resolved from provider config at runtime
  baseUrl?: string | null;
  deployment?: string;    // Azure only
  apiVersion?: string;    // Azure only
  knowledgeBaseRef?: string;
}

/** Dimensions known per well-known model name. */
const KNOWN_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

function dimensionsForModel(model: string): number {
  return KNOWN_DIMENSIONS[model] ?? 1536;
}

/**
 * Build an EmbeddingAgentConfig from a gateway ProviderBase entity.
 */
function buildConfigFromProvider(provider: ProviderBase, model: string): EmbeddingAgentConfig {
  const className = provider.constructor.name;
  const config: EmbeddingAgentConfig = {
    provider: className === 'AzureProvider' ? 'azure'
            : className === 'OllamaProvider' ? 'ollama'
            : 'openai',
    model,
    dimensions: dimensionsForModel(model),
    apiKey: provider.apiKey,
    baseUrl: (provider as any).baseUrl ?? null,
  };
  if (className === 'AzureProvider') {
    config.deployment = (provider as any).deployment;
    config.apiVersion = (provider as any).apiVersion;
  }
  return config;
}

export class EmbeddingAgentService {
  /**
   * Resolve an EmbeddingAgent's config for embedding operations.
   *
   * Resolution order:
   * 1. If agentRef provided: look up agent by name in DB, parse its systemPrompt as JSON config.
   * 2. If no agentRef: fall back to SYSTEM_EMBEDDER_PROVIDER + SYSTEM_EMBEDDER_MODEL env vars.
   * 3. Fall back to Settings singleton (admin-configured defaults).
   * 4. Throw if none is configured.
   */
  async resolveEmbedder(
    agentRef: string | undefined,
    tenantId: string,
    em: EntityManager,
  ): Promise<EmbeddingAgentConfig> {
    if (agentRef) {
      const agent = await em.findOne(Agent, { name: agentRef, tenant: tenantId, kind: 'embedding' });
      if (!agent) {
        throw new Error(`EmbeddingAgent '${agentRef}' not found for tenant ${tenantId}`);
      }
      if (!agent.systemPrompt) {
        throw new Error(`EmbeddingAgent '${agentRef}' has no config stored in systemPrompt`);
      }
      let parsed: Partial<EmbeddingAgentConfig>;
      try {
        parsed = JSON.parse(agent.systemPrompt);
      } catch {
        throw new Error(`EmbeddingAgent '${agentRef}' systemPrompt is not valid JSON`);
      }
      if (!parsed.provider || !parsed.model) {
        throw new Error(`EmbeddingAgent '${agentRef}' config missing required fields: provider, model`);
      }
      return {
        provider: parsed.provider,
        model: parsed.model,
        dimensions: parsed.dimensions ?? dimensionsForModel(parsed.model),
        apiKey: parsed.apiKey ?? process.env.SYSTEM_EMBEDDER_API_KEY,
        knowledgeBaseRef: parsed.knowledgeBaseRef,
      };
    }

    // Fall back to environment variables
    const envProvider = process.env.SYSTEM_EMBEDDER_PROVIDER;
    const envModel = process.env.SYSTEM_EMBEDDER_MODEL;
    if (envProvider && envModel) {
      return {
        provider: envProvider,
        model: envModel,
        dimensions: dimensionsForModel(envModel),
        apiKey: process.env.SYSTEM_EMBEDDER_API_KEY,
      };
    }

    // Fall back to Settings singleton (admin-configured defaults)
    const settings = await em.findOne(Settings, { id: 1 });

    // New path: provider reference
    if (settings?.defaultEmbedderProviderId && settings?.defaultEmbedderModel) {
      const provider = await em.findOne(ProviderBase, { id: settings.defaultEmbedderProviderId });
      if (!provider) {
        throw new Error('Configured default embedder provider no longer exists');
      }
      return buildConfigFromProvider(provider, settings.defaultEmbedderModel);
    }

    // Legacy path: standalone fields
    if (settings?.defaultEmbedderProvider && settings?.defaultEmbedderModel) {
      return {
        provider: settings.defaultEmbedderProvider,
        model: settings.defaultEmbedderModel,
        dimensions: dimensionsForModel(settings.defaultEmbedderModel),
        apiKey: settings.defaultEmbedderApiKey ?? undefined,
      };
    }

    throw new Error(
      'No embedding config available: no agentRef, no SYSTEM_EMBEDDER env vars, and no admin default configured',
    );
  }

  /**
   * Create or update the system-embedder agent for a single tenant.
   * Uses upsert semantics: create if not exists, update systemPrompt if config changed.
   */
  async bootstrapSystemEmbedder(tenantId: string, em: EntityManager): Promise<void> {
    const provider = process.env.SYSTEM_EMBEDDER_PROVIDER;
    const model = process.env.SYSTEM_EMBEDDER_MODEL;
    if (!provider || !model) return;

    const config: EmbeddingAgentConfig = {
      provider,
      model,
      dimensions: dimensionsForModel(model),
    };
    const configJson = JSON.stringify(config);

    const existing = await em.findOne(Agent, { name: 'system-embedder', tenant: tenantId });
    if (existing) {
      if (existing.systemPrompt !== configJson) {
        existing.systemPrompt = configJson;
        existing.updatedAt = new Date();
        await em.flush();
      }
    } else {
      const tenant = await em.findOne(Tenant, { id: tenantId });
      if (!tenant) return;
      const agent = new Agent(tenant, 'system-embedder', {
        kind: 'embedding',
        systemPrompt: configJson,
      });
      em.persist(agent);
      await em.flush();
    }
  }

  /**
   * Bootstrap the system-embedder for ALL active tenants at gateway startup.
   */
  async bootstrapAllTenants(em: EntityManager): Promise<void> {
    const tenants = await em.find(Tenant, { status: 'active' });
    for (const tenant of tenants) {
      await this.bootstrapSystemEmbedder(tenant.id, em);
    }
  }
}
