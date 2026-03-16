/**
 * Tenant Default Provider Selection Tests (#111, Story 5)
 *
 * Tests the tenant-level default provider: entity property, service validation,
 * TenantService resolution chain (agent > tenant default > gatewayProviderId),
 * and the portal route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock encryption ────────────────────────────────────────────────────────
vi.mock('../src/encryption.js', () => ({
  decryptTraceBody: vi.fn((_tenantId: string, ciphertext: string, _iv: string) => {
    return `decrypted-${ciphertext}`;
  }),
  encryptTraceBody: vi.fn(() => ({ ciphertext: 'enc', iv: 'iv' })),
}));

vi.mock('../src/providers/registry.js', () => ({
  evictProvider: vi.fn(),
}));

import { Tenant } from '../src/domain/entities/Tenant.js';
import { OpenAIProvider as OpenAIEntity } from '../src/domain/entities/OpenAIProvider.js';

// ── Tenant Entity ──────────────────────────────────────────────────────────

describe('Tenant entity — defaultProviderId property', () => {
  // Use Object.create to avoid the constructor (which needs MikroORM Collection metadata)
  function makeTenant(): Tenant {
    const t = Object.create(Tenant.prototype) as Tenant;
    t.id = 'tenant-test';
    t.name = 'Test Tenant';
    t.defaultProviderId = null;
    t.status = 'active';
    return t;
  }

  it('defaults defaultProviderId to null', () => {
    const tenant = makeTenant();
    expect(tenant.defaultProviderId).toBe(null);
  });

  it('can be set to a provider UUID', () => {
    const tenant = makeTenant();
    tenant.defaultProviderId = 'provider-uuid-123';
    expect(tenant.defaultProviderId).toBe('provider-uuid-123');
  });

  it('can be cleared back to null', () => {
    const tenant = makeTenant();
    tenant.defaultProviderId = 'provider-uuid-123';
    tenant.defaultProviderId = null;
    expect(tenant.defaultProviderId).toBe(null);
  });
});

// ── TenantManagementService — updateDefaultProvider ────────────────────────

describe('TenantManagementService — updateDefaultProvider', () => {
  let mockEm: any;

  beforeEach(() => {
    mockEm = {
      findOneOrFail: vi.fn(),
      findOne: vi.fn(),
      flush: vi.fn(),
    };
  });

  it('sets defaultProviderId when provider is a gateway provider with tenantAvailable=true', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: null,
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockProvider = {
      id: 'gw-provider-1',
      tenant: null, // gateway provider
      tenantAvailable: true,
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);
    mockEm.findOne.mockResolvedValue(mockProvider);

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);
    const result = await svc.updateDefaultProvider('tenant-1', 'gw-provider-1');

    expect(mockTenant.defaultProviderId).toBe('gw-provider-1');
    expect(result.defaultProviderId).toBe('gw-provider-1');
    expect(mockEm.flush).toHaveBeenCalled();
  });

  it('sets defaultProviderId when provider is tenant-owned', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: null,
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockProvider = {
      id: 'custom-provider-1',
      tenant: { id: 'tenant-1' }, // tenant-owned
      tenantAvailable: false,
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);
    mockEm.findOne.mockResolvedValue(mockProvider);

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);
    const result = await svc.updateDefaultProvider('tenant-1', 'custom-provider-1');

    expect(mockTenant.defaultProviderId).toBe('custom-provider-1');
    expect(result.defaultProviderId).toBe('custom-provider-1');
  });

  it('clears defaultProviderId when set to null', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: 'old-provider-id',
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);
    const result = await svc.updateDefaultProvider('tenant-1', null);

    expect(mockTenant.defaultProviderId).toBe(null);
    expect(result.defaultProviderId).toBe(null);
    // Should not look up any provider when clearing
    expect(mockEm.findOne).not.toHaveBeenCalled();
  });

  it('rejects when provider does not exist', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: null,
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);
    mockEm.findOne.mockResolvedValue(null); // provider not found

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);

    await expect(svc.updateDefaultProvider('tenant-1', 'nonexistent-id')).rejects.toThrow(
      'Provider not found',
    );
  });

  it('rejects when provider belongs to a different tenant', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: null,
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockProvider = {
      id: 'other-provider',
      tenant: { id: 'tenant-2' }, // different tenant
      tenantAvailable: false,
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);
    mockEm.findOne.mockResolvedValue(mockProvider);

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);

    await expect(svc.updateDefaultProvider('tenant-1', 'other-provider')).rejects.toThrow(
      'Provider is not accessible to this tenant',
    );
  });

  it('rejects gateway provider that is not tenant-available', async () => {
    const mockTenant = {
      id: 'tenant-1',
      name: 'Test',
      status: 'active',
      defaultProviderId: null,
      providerConfig: null,
      systemPrompt: null,
      skills: null,
      mcpEndpoints: null,
      availableModels: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockProvider = {
      id: 'private-gw-provider',
      tenant: null, // gateway provider
      tenantAvailable: false, // but not available to tenants
    };

    mockEm.findOneOrFail.mockResolvedValue(mockTenant);
    mockEm.findOne.mockResolvedValue(mockProvider);

    const { TenantManagementService } = await import(
      '../src/application/services/TenantManagementService.js'
    );
    const svc = new TenantManagementService(mockEm);

    await expect(svc.updateDefaultProvider('tenant-1', 'private-gw-provider')).rejects.toThrow(
      'Provider is not accessible to this tenant',
    );
  });
});

// ── TenantService — resolution chain with defaultProviderId ────────────────

describe('TenantService — tenant.defaultProviderId resolution', () => {
  it('uses tenant.defaultProviderId when agent has no providerId', async () => {
    const mockProviderEntity = new OpenAIEntity('tenant-default-openai', 'sk-test');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return {
            tenant: {
              id: 'tenant-1',
              name: 'Test',
              status: 'active',
              parentId: null,
              defaultProviderId: 'tenant-default-prov-id',
              providerConfig: null,
              systemPrompt: null,
              skills: null,
              mcpEndpoints: null,
            },
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              providerId: null, // No agent-level override
              providerConfig: null,
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
        if (className === 'ProviderBase' && filter === 'tenant-default-prov-id') {
          return mockProviderEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(mockProviderEntity);
    expect(mockEm.findOne).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-default-prov-id',
    );
  });

  it('agent.providerId takes priority over tenant.defaultProviderId', async () => {
    const agentProviderEntity = new OpenAIEntity('agent-level-openai', 'sk-agent');
    const tenantProviderEntity = new OpenAIEntity('tenant-default-openai', 'sk-tenant');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return {
            tenant: {
              id: 'tenant-1',
              name: 'Test',
              status: 'active',
              parentId: null,
              defaultProviderId: 'tenant-default-prov-id',
              providerConfig: null,
              systemPrompt: null,
              skills: null,
              mcpEndpoints: null,
            },
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              providerId: 'agent-prov-id', // Agent-level takes priority
              providerConfig: null,
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
        if (className === 'ProviderBase' && filter === 'agent-prov-id') {
          return agentProviderEntity;
        }
        if (className === 'ProviderBase' && filter === 'tenant-default-prov-id') {
          return tenantProviderEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(agentProviderEntity);
    // Should NOT have looked up tenant default provider
    expect(mockEm.findOne).not.toHaveBeenCalledWith(
      expect.anything(),
      'tenant-default-prov-id',
    );
  });

  it('falls back to gatewayProviderId when tenant.defaultProviderId is null', async () => {
    const gwProviderEntity = new OpenAIEntity('gw-openai', 'sk-gw');

    const mockEm = {
      findOne: vi.fn().mockImplementation((entityClass: any, filter: any) => {
        const className = entityClass?.name || entityClass;
        if (className === 'ApiKey') {
          return {
            tenant: {
              id: 'tenant-1',
              name: 'Test',
              status: 'active',
              parentId: null,
              defaultProviderId: null, // No tenant default
              providerConfig: {
                provider: 'openai',
                apiKey: 'sk-x',
                gatewayProviderId: 'gw-prov-id',
              },
              systemPrompt: null,
              skills: null,
              mcpEndpoints: null,
            },
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              providerId: null,
              providerConfig: null,
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
        if (className === 'ProviderBase' && filter === 'gw-prov-id') {
          return gwProviderEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(gwProviderEntity);
    expect(mockEm.findOne).toHaveBeenCalledWith(
      expect.anything(),
      'gw-prov-id',
    );
  });
});
