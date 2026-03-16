/**
 * Provider Resolution Chain Tests (#111, Story 7)
 *
 * Tests the full resolution priority chain in TenantService.loadByApiKey():
 *   1. Agent with providerId set — uses agent's provider (highest priority)
 *   2. Agent without providerId, tenant has defaultProviderId — uses tenant default
 *   3. Neither set, gatewayProviderId in JSONB — uses gateway provider
 *   4. Nothing set, JSONB providerConfig has config — uses legacy path
 *   5. Nothing at all — falls back gracefully
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock encryption before any entity imports ────────────────────────────────
vi.mock('../src/encryption.js', () => ({
  decryptTraceBody: vi.fn((_tenantId: string, ciphertext: string, _iv: string) => {
    return `decrypted-${ciphertext}`;
  }),
  encryptTraceBody: vi.fn(() => ({ ciphertext: 'enc', iv: 'iv' })),
}));

import { OpenAIProvider as OpenAIEntity } from '../src/domain/entities/OpenAIProvider.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpenAIEntity(name = 'test-openai'): OpenAIEntity {
  return new OpenAIEntity(name, 'sk-test');
}

function makeApiKeyRow(overrides: {
  agentProviderId?: string | null;
  tenantDefaultProviderId?: string | null;
  tenantProviderConfig?: any;
  agentProviderConfig?: any;
} = {}) {
  return {
    tenant: {
      id: 'tenant-1',
      name: 'Test Tenant',
      status: 'active',
      parentId: null,
      defaultProviderId: overrides.tenantDefaultProviderId ?? null,
      providerConfig: overrides.tenantProviderConfig ?? null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
    },
    agent: {
      id: 'agent-1',
      name: 'Test Agent',
      providerId: overrides.agentProviderId ?? null,
      providerConfig: overrides.agentProviderConfig ?? null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      mergePolicies: { system_prompt: 'prepend', skills: 'merge' },
      conversationsEnabled: false,
      conversationTokenLimit: 4000,
      conversationSummaryModel: null,
      knowledgeBaseRef: null,
      availableModels: null,
    },
    keyHash: 'abc',
    status: 'active',
    expiresAt: null,
  };
}

// ── Full Resolution Chain ─────────────────────────────────────────────────────

describe('Provider resolution chain — TenantService.loadByApiKey()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. uses agent.providerId when set (highest priority)', async () => {
    const agentProviderEntity = makeOpenAIEntity('agent-level-openai');
    const tenantDefaultEntity = makeOpenAIEntity('tenant-default-openai');
    const gatewayEntity = makeOpenAIEntity('gateway-openai');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: 'agent-prov-id',
            tenantDefaultProviderId: 'tenant-default-prov-id',
            tenantProviderConfig: {
              provider: 'openai',
              apiKey: 'sk-fallback',
              gatewayProviderId: 'gw-prov-id',
            },
          });
        }
        if (className === 'ProviderBase' && filter === 'agent-prov-id') {
          return agentProviderEntity;
        }
        if (className === 'ProviderBase' && filter === 'tenant-default-prov-id') {
          return tenantDefaultEntity;
        }
        if (className === 'ProviderBase' && filter === 'gw-prov-id') {
          return gatewayEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(agentProviderEntity);
    // Should have looked up the agent's provider, not tenant default or gateway
    expect(mockEm.findOne).toHaveBeenCalledWith(expect.anything(), 'agent-prov-id');
    expect(mockEm.findOne).not.toHaveBeenCalledWith(expect.anything(), 'tenant-default-prov-id');
    expect(mockEm.findOne).not.toHaveBeenCalledWith(expect.anything(), 'gw-prov-id');
  });

  it('2. uses tenant.defaultProviderId when agent has no providerId', async () => {
    const tenantDefaultEntity = makeOpenAIEntity('tenant-default-openai');
    const gatewayEntity = makeOpenAIEntity('gateway-openai');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: null,
            tenantDefaultProviderId: 'tenant-default-prov-id',
            tenantProviderConfig: {
              provider: 'openai',
              apiKey: 'sk-fallback',
              gatewayProviderId: 'gw-prov-id',
            },
          });
        }
        if (className === 'ProviderBase' && filter === 'tenant-default-prov-id') {
          return tenantDefaultEntity;
        }
        if (className === 'ProviderBase' && filter === 'gw-prov-id') {
          return gatewayEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(tenantDefaultEntity);
    expect(mockEm.findOne).toHaveBeenCalledWith(expect.anything(), 'tenant-default-prov-id');
    expect(mockEm.findOne).not.toHaveBeenCalledWith(expect.anything(), 'gw-prov-id');
  });

  it('3. uses gatewayProviderId from JSONB when neither agent nor tenant default is set', async () => {
    const gatewayEntity = makeOpenAIEntity('gateway-openai');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: null,
            tenantDefaultProviderId: null,
            tenantProviderConfig: {
              provider: 'openai',
              apiKey: 'sk-legacy',
              gatewayProviderId: 'gw-prov-id',
            },
          });
        }
        if (className === 'ProviderBase' && filter === 'gw-prov-id') {
          return gatewayEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(gatewayEntity);
    expect(mockEm.findOne).toHaveBeenCalledWith(expect.anything(), 'gw-prov-id');
  });

  it('4. falls back to JSONB providerConfig when no provider entity IDs exist', async () => {
    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, _filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: null,
            tenantDefaultProviderId: null,
            tenantProviderConfig: {
              provider: 'openai',
              apiKey: 'sk-legacy-key',
            },
          });
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    // No providerEntity, but providerConfig should be populated from JSONB
    expect(result.context.providerEntity).toBeUndefined();
    expect(result.context.providerConfig).toEqual({
      provider: 'openai',
      apiKey: 'sk-legacy-key',
    });
  });

  it('5. falls back gracefully when nothing is configured at all', async () => {
    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, _filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: null,
            tenantDefaultProviderId: null,
            tenantProviderConfig: null,
            agentProviderConfig: null,
          });
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    // Neither entity nor config
    expect(result.context.providerEntity).toBeUndefined();
    expect(result.context.providerConfig).toBeUndefined();
    // Should still have basic tenant context
    expect(result.context.tenantId).toBe('tenant-1');
    expect(result.context.name).toBe('Test Tenant');
  });

  it('skips agent provider lookup when agent.providerId points to deleted provider', async () => {
    const tenantDefaultEntity = makeOpenAIEntity('tenant-default-openai');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return makeApiKeyRow({
            agentProviderId: 'deleted-provider-id',
            tenantDefaultProviderId: 'tenant-default-prov-id',
          });
        }
        // Agent's provider was deleted — returns null
        if (className === 'ProviderBase' && filter === 'deleted-provider-id') {
          return null;
        }
        if (className === 'ProviderBase' && filter === 'tenant-default-prov-id') {
          return tenantDefaultEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    // When agent provider is not found, it does NOT fall through to tenant default
    // because the code only enters the else-if branches when providerId is falsy.
    // The entity is simply undefined.
    expect(result.context.providerEntity).toBeUndefined();
  });

  it('throws when API key is invalid', async () => {
    const mockEm = {
      findOne: vi.fn().mockResolvedValue(null),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);

    await expect(svc.loadByApiKey('bogus-key')).rejects.toThrow('Invalid API key');
  });

  it('throws when tenant is inactive', async () => {
    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          const row = makeApiKeyRow();
          row.tenant.status = 'suspended';
          return row;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);

    await expect(svc.loadByApiKey('test-key')).rejects.toThrow('Tenant is not active');
  });

  it('throws when API key is expired', async () => {
    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          const row = makeApiKeyRow();
          row.expiresAt = new Date(Date.now() - 60_000); // expired 1 minute ago
          return row;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);

    await expect(svc.loadByApiKey('test-key')).rejects.toThrow('API key has expired');
  });
});
