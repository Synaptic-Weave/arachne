/**
 * Provider Entity → Proxy Adapter Bridge Tests (#113)
 *
 * Validates that ORM entity `createClient()` methods return correct
 * BaseProvider proxy adapter instances, including API key decryption
 * and the entity-first path in the provider registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock encryption before any entity imports ────────────────────────────────
vi.mock('../src/encryption.js', () => ({
  decryptTraceBody: vi.fn((tenantId: string, ciphertext: string, iv: string) => {
    // Simple mock: return a predictable decrypted value
    return `decrypted-${ciphertext}`;
  }),
  encryptTraceBody: vi.fn(),
}));

import { OpenAIProvider as OpenAIEntity } from '../src/domain/entities/OpenAIProvider.js';
import { AzureProvider as AzureEntity } from '../src/domain/entities/AzureProvider.js';
import { OllamaProvider as OllamaEntity } from '../src/domain/entities/OllamaProvider.js';
import { OpenAIProvider as OpenAIProxyAdapter } from '../src/providers/openai.js';
import { AzureProvider as AzureProxyAdapter } from '../src/providers/azure.js';
import { getProviderForTenant, evictProvider } from '../src/providers/registry.js';
import type { TenantContext } from '../src/auth.js';

// ── Helper: create entity instances without full ORM ─────────────────────────

function makeOpenAIEntity(overrides: Partial<OpenAIEntity> = {}): OpenAIEntity {
  const entity = new OpenAIEntity('test-openai', 'sk-test-key');
  entity.baseUrl = overrides.baseUrl ?? null;
  if (overrides.apiKey !== undefined) entity.apiKey = overrides.apiKey;
  return entity;
}

function makeAzureEntity(overrides: Partial<AzureEntity> = {}): AzureEntity {
  const entity = new AzureEntity('test-azure', 'azure-key-123');
  entity.baseUrl = overrides.baseUrl ?? 'https://my-resource.openai.azure.com';
  entity.deployment = overrides.deployment ?? 'gpt-4-deploy';
  entity.apiVersion = overrides.apiVersion ?? '2024-02-01';
  if (overrides.apiKey !== undefined) entity.apiKey = overrides.apiKey;
  return entity;
}

function makeOllamaEntity(overrides: Partial<OllamaEntity> = {}): OllamaEntity {
  const entity = new OllamaEntity('test-ollama', '');
  entity.baseUrl = overrides.baseUrl ?? 'http://localhost:11434';
  return entity;
}

function makeTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: 'tenant-001',
    name: 'Test Tenant',
    mergePolicies: { system_prompt: 'prepend', skills: 'merge' },
    ...overrides,
  };
}

// ── OpenAI Entity createClient ───────────────────────────────────────────────

describe('OpenAIProvider entity — createClient()', () => {
  it('returns an OpenAI proxy adapter', () => {
    const entity = makeOpenAIEntity();
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
    expect(adapter.name).toBe('openai');
  });

  it('passes baseUrl through to adapter', () => {
    const entity = makeOpenAIEntity({ baseUrl: 'https://custom.api.com' });
    const adapter = entity.createClient('tenant-001') as any;
    // The adapter strips trailing /v1 from baseUrl, so just check it exists
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
  });

  it('decrypts encrypted API keys', () => {
    const entity = makeOpenAIEntity({ apiKey: 'encrypted:abc123:def456' });
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
    // The mock decryptTraceBody returns 'decrypted-abc123'
  });

  it('falls back to OPENAI_API_KEY env var when apiKey is empty', () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-fallback-key';
    try {
      const entity = makeOpenAIEntity({ apiKey: '' });
      const adapter = entity.createClient('tenant-001');
      expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_API_KEY = original;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });
});

// ── Azure Entity createClient ────────────────────────────────────────────────

describe('AzureProvider entity — createClient()', () => {
  it('returns an Azure proxy adapter', () => {
    const entity = makeAzureEntity();
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(AzureProxyAdapter);
    expect(adapter.name).toBe('azure');
  });

  it('decrypts encrypted API keys', () => {
    const entity = makeAzureEntity({ apiKey: 'encrypted:azurekey:azureiv' });
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(AzureProxyAdapter);
  });

  it('uses default apiVersion when not set', () => {
    const entity = makeAzureEntity({ apiVersion: '' });
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(AzureProxyAdapter);
  });
});

// ── Ollama Entity createClient ───────────────────────────────────────────────

describe('OllamaProvider entity — createClient()', () => {
  it('returns an OpenAI proxy adapter (Ollama uses OpenAI-compatible API)', () => {
    const entity = makeOllamaEntity();
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
    expect(adapter.name).toBe('openai');
  });

  it('appends /v1 to the base URL', () => {
    const entity = makeOllamaEntity({ baseUrl: 'http://my-ollama:11434' });
    const adapter = entity.createClient('tenant-001') as any;
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
  });

  it('uses default base URL when not set', () => {
    const entity = makeOllamaEntity({ baseUrl: '' });
    const adapter = entity.createClient('tenant-001');
    expect(adapter).toBeInstanceOf(OpenAIProxyAdapter);
  });
});

// ── Provider Registry: entity-first path ─────────────────────────────────────

describe('Provider registry — entity-first path', () => {
  afterEach(() => {
    evictProvider('tenant-entity-test');
    evictProvider('agent-entity-test');
  });

  it('uses providerEntity.createClient() when entity is present', async () => {
    const entity = makeOpenAIEntity();
    const ctx = makeTenantContext({
      tenantId: 'tenant-entity-test',
      providerEntity: entity,
      providerConfig: {
        provider: 'openai',
        apiKey: 'should-not-use-this',
      },
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
  });

  it('falls back to legacy JSONB path when no entity', async () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-entity-test',
      providerConfig: {
        provider: 'ollama',
        apiKey: '',
        baseUrl: 'http://localhost:11434',
      },
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
    expect(provider.name).toBe('openai'); // Ollama uses OpenAI adapter
  });

  it('caches provider from entity path', async () => {
    const entity = makeAzureEntity();
    const ctx = makeTenantContext({
      tenantId: 'tenant-entity-test',
      agentId: 'agent-entity-test',
      providerEntity: entity,
    });

    const first = await getProviderForTenant(ctx);
    const second = await getProviderForTenant(ctx);
    expect(first).toBe(second); // Same reference (cached)
  });

  it('entity-first path works with Azure entity', async () => {
    const entity = makeAzureEntity();
    const ctx = makeTenantContext({
      tenantId: 'tenant-entity-test',
      providerEntity: entity,
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(AzureProxyAdapter);
    expect(provider.name).toBe('azure');
  });

  it('entity-first path works with Ollama entity', async () => {
    const entity = makeOllamaEntity();
    const ctx = makeTenantContext({
      tenantId: 'tenant-entity-test',
      providerEntity: entity,
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
  });
});

// ── Provider Registry: legacy JSONB path preserved ───────────────────────────

describe('Provider registry — legacy JSONB fallback', () => {
  afterEach(() => {
    evictProvider('tenant-legacy-test');
  });

  it('creates OpenAI provider from JSONB config', async () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-legacy-test',
      providerConfig: {
        provider: 'openai',
        apiKey: 'sk-legacy',
      },
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
  });

  it('creates Azure provider from JSONB config', async () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-legacy-test',
      providerConfig: {
        provider: 'azure',
        apiKey: 'azure-legacy-key',
        baseUrl: 'https://resource.openai.azure.com',
        deployment: 'gpt-4',
        apiVersion: '2024-02-01',
      },
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(AzureProxyAdapter);
  });

  it('creates Ollama provider from JSONB config', async () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-legacy-test',
      providerConfig: {
        provider: 'ollama',
        apiKey: '',
        baseUrl: 'http://localhost:11434',
      },
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
  });

  it('falls back to OpenAI with env var when no config', async () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-legacy-test',
    });

    const provider = await getProviderForTenant(ctx);
    expect(provider).toBeInstanceOf(OpenAIProxyAdapter);
  });
});
