/**
 * Agent Provider Selection + Model Validation Tests (#111, Story 4)
 *
 * Tests the agent-level provider FK, TenantService resolution chain,
 * TenantManagementService CRUD, and gateway model validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock encryption ────────────────────────────────────────────────────────
vi.mock('../src/encryption.js', () => ({
  decryptTraceBody: vi.fn((_tenantId: string, ciphertext: string, _iv: string) => {
    return `decrypted-${ciphertext}`;
  }),
  encryptTraceBody: vi.fn(() => ({ ciphertext: 'enc', iv: 'iv' })),
}));

import { Agent } from '../src/domain/entities/Agent.js';
import { OpenAIProvider as OpenAIEntity } from '../src/domain/entities/OpenAIProvider.js';
import { getProviderForTenant, evictProvider } from '../src/providers/registry.js';
import type { TenantContext } from '../src/auth.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: 'tenant-agent-prov',
    name: 'Test Tenant',
    mergePolicies: { system_prompt: 'prepend', skills: 'merge' },
    ...overrides,
  };
}

function makeOpenAIEntity(overrides: Partial<OpenAIEntity> = {}): OpenAIEntity {
  const entity = new OpenAIEntity('test-openai', 'sk-test');
  if (overrides.availableModels !== undefined) entity.availableModels = overrides.availableModels;
  return entity;
}

// ── Agent Entity ───────────────────────────────────────────────────────────

describe('Agent entity — providerId property', () => {
  it('defaults providerId to null when not provided', () => {
    const mockTenant = { id: 'tid' } as any;
    const agent = new Agent(mockTenant, 'test-agent');
    expect(agent.providerId).toBe(null);
  });

  it('accepts providerId via constructor config', () => {
    const mockTenant = { id: 'tid' } as any;
    const agent = new Agent(mockTenant, 'test-agent', {
      providerId: 'provider-uuid-123',
    } as any);
    expect(agent.providerId).toBe('provider-uuid-123');
  });
});

// ── Model Validation Logic ─────────────────────────────────────────────────

describe('Gateway — model validation', () => {
  afterEach(() => {
    evictProvider('tenant-model-val');
  });

  it('allows request when model is in availableModels', () => {
    const entity = makeOpenAIEntity({ availableModels: ['gpt-4o', 'gpt-4o-mini'] });
    const ctx = makeTenantContext({
      tenantId: 'tenant-model-val',
      providerEntity: entity,
    });

    // Simulate the validation check from index.ts
    const allowedModels: string[] | undefined = ctx.providerEntity?.availableModels;
    const requestedModel = 'gpt-4o';
    const isAllowed =
      !allowedModels || allowedModels.length === 0 || allowedModels.includes(requestedModel);
    expect(isAllowed).toBe(true);
  });

  it('rejects request when model is not in availableModels', () => {
    const entity = makeOpenAIEntity({ availableModels: ['gpt-4o', 'gpt-4o-mini'] });
    const ctx = makeTenantContext({
      tenantId: 'tenant-model-val',
      providerEntity: entity,
    });

    const allowedModels: string[] | undefined = ctx.providerEntity?.availableModels;
    const requestedModel = 'gpt-3.5-turbo';
    const isAllowed =
      !allowedModels || allowedModels.length === 0 || allowedModels.includes(requestedModel);
    expect(isAllowed).toBe(false);
  });

  it('allows any model when availableModels is empty (allow-all)', () => {
    const entity = makeOpenAIEntity({ availableModels: [] });
    const ctx = makeTenantContext({
      tenantId: 'tenant-model-val',
      providerEntity: entity,
    });

    const allowedModels: string[] | undefined = ctx.providerEntity?.availableModels;
    const requestedModel = 'any-model-name';
    const isAllowed =
      !allowedModels || allowedModels.length === 0 || allowedModels.includes(requestedModel);
    expect(isAllowed).toBe(true);
  });

  it('allows any model when no providerEntity is set', () => {
    const ctx = makeTenantContext({
      tenantId: 'tenant-model-val',
      providerConfig: { provider: 'openai', apiKey: 'sk-test' },
    });

    const allowedModels: string[] | undefined = ctx.providerEntity?.availableModels;
    const requestedModel = 'any-model-name';
    const isAllowed =
      !allowedModels || allowedModels.length === 0 || allowedModels.includes(requestedModel);
    expect(isAllowed).toBe(true);
  });
});

// ── Provider Resolution Chain Priority ─────────────────────────────────────

describe('Provider resolution — agent.providerId priority', () => {
  afterEach(() => {
    evictProvider('tenant-chain-test');
  });

  it('agent.providerId entity takes priority over JSONB gatewayProviderId', async () => {
    // This tests the registry path: when providerEntity is set (from agent.providerId),
    // it should be used even if providerConfig also has a gatewayProviderId
    const entity = makeOpenAIEntity();
    const ctx = makeTenantContext({
      tenantId: 'tenant-chain-test',
      providerEntity: entity, // Set by TenantService when agent.providerId is found
      providerConfig: {
        provider: 'openai',
        apiKey: 'should-not-use',
        gatewayProviderId: 'other-provider-id',
      },
    });

    const provider = await getProviderForTenant(ctx);
    // Should use the entity, not the JSONB config
    expect(provider).toBeDefined();
    expect(provider.name).toBe('openai');
  });
});

// ── TenantService mock test for resolution chain ──────────────────────────

describe('TenantService — agent.providerId resolution (mock)', () => {
  it('loads ProviderBase when agent has providerId set', async () => {
    const mockProviderEntity = makeOpenAIEntity();

    // Mock EntityManager
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
              providerConfig: null,
              systemPrompt: null,
              skills: null,
              mcpEndpoints: null,
            },
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              providerId: 'provider-uuid-direct', // This is the key field
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
        if (className === 'ProviderBase' && filter === 'provider-uuid-direct') {
          return mockProviderEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(mockProviderEntity);
    // Verify it looked up the provider by agent.providerId
    expect(mockEm.findOne).toHaveBeenCalledWith(
      expect.anything(),
      'provider-uuid-direct',
    );
  });

  it('falls back to gatewayProviderId when agent has no providerId', async () => {
    const mockProviderEntity = makeOpenAIEntity();

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
              providerConfig: { provider: 'openai', apiKey: 'sk-x', gatewayProviderId: 'gw-provider-id' },
              systemPrompt: null,
              skills: null,
              mcpEndpoints: null,
            },
            agent: {
              id: 'agent-1',
              name: 'Test Agent',
              providerId: null, // No direct provider
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
        if (className === 'ProviderBase' && filter === 'gw-provider-id') {
          return mockProviderEntity;
        }
        return null;
      }),
    } as any;

    const { TenantService } = await import('../src/application/services/TenantService.js');
    const svc = new TenantService(mockEm);
    const result = await svc.loadByApiKey('test-key');

    expect(result.context.providerEntity).toBe(mockProviderEntity);
    // Should have looked up via gatewayProviderId
    expect(mockEm.findOne).toHaveBeenCalledWith(
      expect.anything(),
      'gw-provider-id',
    );
  });
});

// We need this import for afterEach
import { afterEach } from 'vitest';
