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

export interface EmbedTextsResult {
  embeddings: number[][];
  model: string;
  dimensions: number;
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
   * Generate embeddings for an array of texts using the resolved embedding provider.
   * Batches at 100 texts per API request and rate-limits at ~260k tokens per minute.
   * Supports OpenAI (batch via `input` array), Azure, and Ollama (one-at-a-time).
   */
  async embedTexts(
    texts: string[],
    config: EmbeddingAgentConfig,
    logger?: { info: (msg: string) => void },
  ): Promise<EmbedTextsResult> {
    if (config.provider === 'ollama') {
      // Ollama does not support batch embedding; loop sequentially
      const embeddings: number[][] = [];
      for (const text of texts) {
        const baseUrl = config.baseUrl ?? 'http://localhost:11434';
        const resp = await fetch(`${baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, prompt: text }),
        });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          throw new Error(`Embedding API error ${resp.status}: ${errBody}`);
        }
        const data = (await resp.json()) as any;
        embeddings.push(data.embedding as number[]);
      }
      return {
        embeddings,
        model: config.model,
        dimensions: config.dimensions,
      };
    }

    const API_BATCH_SIZE = 100;
    const TOKEN_BUDGET = 260_000; // 75% of 350k TPM
    const RATE_WINDOW_MS = 60_000;

    // Group texts into rate-limit windows based on estimated token count
    const rateBatches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
      const est = Math.ceil(text.length / 4);
      if (current.length > 0 && currentTokens + est > TOKEN_BUDGET) {
        rateBatches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += est;
    }
    if (current.length > 0) rateBatches.push(current);

    const allEmbeddings: number[][] = [];

    for (let rb = 0; rb < rateBatches.length; rb++) {
      if (rb > 0) {
        if (rateBatches.length > 1) {
          logger?.info(`Embedding rate-limit pause: waiting 60s before batch ${rb + 1}/${rateBatches.length}`);
        }
        await new Promise((r) => setTimeout(r, RATE_WINDOW_MS));
      }
      if (rateBatches.length > 1) {
        logger?.info(`Embedding rate-batch ${rb + 1}/${rateBatches.length} (${rateBatches[rb].length} chunks)`);
      }

      const rateBatch = rateBatches[rb];

      for (let i = 0; i < rateBatch.length; i += API_BATCH_SIZE) {
        const batch = rateBatch.slice(i, i + API_BATCH_SIZE);

        let url: string;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        let body: object;

        if (config.provider === 'azure') {
          const baseUrl = config.baseUrl ?? '';
          if (!baseUrl) {
            throw new Error('Azure embedding provider requires a baseUrl (e.g., https://<resource>.openai.azure.com)');
          }
          const deployment = config.deployment ?? config.model;
          const apiVersion = config.apiVersion ?? '2024-02-01';
          url = `${baseUrl}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
          headers['api-key'] = config.apiKey ?? '';
          body = { input: batch };
        } else {
          // OpenAI or OpenAI-compatible
          const baseUrl = config.baseUrl ?? 'https://api.openai.com';
          url = `${baseUrl}/v1/embeddings`;
          headers['Authorization'] = `Bearer ${config.apiKey ?? ''}`;
          body = { model: config.model, input: batch };
        }

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          throw new Error(`Embedding API error ${resp.status}: ${errBody}`);
        }

        const data = (await resp.json()) as any;
        // OpenAI/Azure return { data: [{ embedding: [...], index: N }, ...] }
        const sorted = (data.data as Array<{ embedding: number[]; index: number }>)
          .sort((a, b) => a.index - b.index);
        allEmbeddings.push(...sorted.map((d) => d.embedding));
      }
    }

    return {
      embeddings: allEmbeddings,
      model: config.model,
      dimensions: config.dimensions,
    };
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
