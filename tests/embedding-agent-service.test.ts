/**
 * Unit tests for src/services/EmbeddingAgentService.ts
 * Covers: resolveEmbedder, bootstrapSystemEmbedder, dimensionsForModel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EntityManager } from '@mikro-orm/core';
import { EmbeddingAgentService } from '../src/services/EmbeddingAgentService.js';
import { Agent } from '../src/domain/entities/Agent.js';
import { Tenant } from '../src/domain/entities/Tenant.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockEm(overrides: Partial<Record<string, unknown>> = {}): EntityManager {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockResolvedValue([]),
    persist: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    persistAndFlush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EntityManager;
}

function makeTenant(id = 'tenant-1'): Tenant {
  return Object.assign(Object.create(Tenant.prototype) as Tenant, {
    id,
    name: 'Test Tenant',
    parentId: null,
    providerConfig: null,
    systemPrompt: null,
    skills: null,
    mcpEndpoints: null,
    status: 'active',
    availableModels: null,
    agents: [],
    members: [],
    invites: [],
    createdAt: new Date(),
    updatedAt: null,
  });
}

function makeEmbeddingAgent(overrides: Partial<Agent> = {}): Agent {
  const tenant = makeTenant();
  return Object.assign(Object.create(Agent.prototype) as Agent, {
    id: 'agent-1',
    name: 'test-embedder',
    kind: 'embedding',
    tenant,
    systemPrompt: JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small' }),
    providerConfig: null,
    skills: null,
    mcpEndpoints: null,
    mergePolicies: {},
    createdAt: new Date(),
    updatedAt: null,
    apiKeys: [],
    ...overrides,
  });
}

// ── resolveEmbedder ───────────────────────────────────────────────────────────

describe('EmbeddingAgentService.resolveEmbedder', () => {
  let service: EmbeddingAgentService;

  beforeEach(() => {
    service = new EmbeddingAgentService();
  });

  afterEach(() => {
    delete process.env.SYSTEM_EMBEDDER_PROVIDER;
    delete process.env.SYSTEM_EMBEDDER_MODEL;
    delete process.env.SYSTEM_EMBEDDER_API_KEY;
    vi.clearAllMocks();
  });

  it('returns config from named agent when agentRef is provided and agent exists', async () => {
    const agent = makeEmbeddingAgent({
      systemPrompt: JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small' }),
    });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    const config = await service.resolveEmbedder('test-embedder', 'tenant-1', em);

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimensions).toBe(1536);
  });

  it('looks up agent by name + tenantId + kind=embedding', async () => {
    const agent = makeEmbeddingAgent();
    const findOneMock = vi.fn().mockResolvedValue(agent);
    const em = buildMockEm({ findOne: findOneMock });

    await service.resolveEmbedder('test-embedder', 'tenant-42', em);

    expect(findOneMock).toHaveBeenCalledWith(Agent, {
      name: 'test-embedder',
      tenant: 'tenant-42',
      kind: 'embedding',
    });
  });

  it('falls back to env vars when no agentRef provided', async () => {
    process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
    process.env.SYSTEM_EMBEDDER_MODEL = 'text-embedding-3-large';
    process.env.SYSTEM_EMBEDDER_API_KEY = 'sk-env-key';
    const em = buildMockEm();

    const config = await service.resolveEmbedder(undefined, 'tenant-1', em);

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(3072);
    expect(config.apiKey).toBe('sk-env-key');
  });

  it('throws when agentRef provided but agent not found in DB', async () => {
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(null) });

    await expect(service.resolveEmbedder('missing-embedder', 'tenant-1', em))
      .rejects.toThrow("EmbeddingAgent 'missing-embedder' not found for tenant tenant-1");
  });

  it('throws when agent has no systemPrompt config', async () => {
    const agent = makeEmbeddingAgent({ systemPrompt: null });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    await expect(service.resolveEmbedder('test-embedder', 'tenant-1', em))
      .rejects.toThrow("has no config stored in systemPrompt");
  });

  it('throws when agent systemPrompt is not valid JSON', async () => {
    const agent = makeEmbeddingAgent({ systemPrompt: 'not-valid-json{' });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    await expect(service.resolveEmbedder('test-embedder', 'tenant-1', em))
      .rejects.toThrow('systemPrompt is not valid JSON');
  });

  it('throws when agent config is missing required provider field', async () => {
    const agent = makeEmbeddingAgent({ systemPrompt: JSON.stringify({ model: 'text-embedding-3-small' }) });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    await expect(service.resolveEmbedder('test-embedder', 'tenant-1', em))
      .rejects.toThrow('config missing required fields: provider, model');
  });

  it('throws when agent config is missing required model field', async () => {
    const agent = makeEmbeddingAgent({ systemPrompt: JSON.stringify({ provider: 'openai' }) });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    await expect(service.resolveEmbedder('test-embedder', 'tenant-1', em))
      .rejects.toThrow('config missing required fields: provider, model');
  });

  it('throws when neither agentRef nor env vars are configured', async () => {
    const em = buildMockEm();

    await expect(service.resolveEmbedder(undefined, 'tenant-1', em))
      .rejects.toThrow('No embedding config available');
  });

  it('uses explicit dimensions from agent config when provided', async () => {
    const agent = makeEmbeddingAgent({
      systemPrompt: JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 512 }),
    });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(agent) });

    const config = await service.resolveEmbedder('test-embedder', 'tenant-1', em);

    expect(config.dimensions).toBe(512);
  });
});

// ── bootstrapSystemEmbedder ───────────────────────────────────────────────────

describe('EmbeddingAgentService.bootstrapSystemEmbedder', () => {
  let service: EmbeddingAgentService;

  beforeEach(() => {
    service = new EmbeddingAgentService();
  });

  afterEach(() => {
    delete process.env.SYSTEM_EMBEDDER_PROVIDER;
    delete process.env.SYSTEM_EMBEDDER_MODEL;
    vi.clearAllMocks();
  });

  it('skips entirely when env vars are not set', async () => {
    const em = buildMockEm();

    await service.bootstrapSystemEmbedder('tenant-1', em);

    expect((em.findOne as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((em.persist as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('creates system-embedder agent when it does not exist and tenant is found', async () => {
    process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
    process.env.SYSTEM_EMBEDDER_MODEL = 'text-embedding-ada-002';

    const tenant = makeTenant('tenant-1');
    const em = buildMockEm({
      findOne: vi.fn()
        .mockResolvedValueOnce(null)   // no existing system-embedder
        .mockResolvedValueOnce(tenant), // tenant lookup succeeds
    });

    await service.bootstrapSystemEmbedder('tenant-1', em);

    expect((em.persist as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((em.flush as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('updates systemPrompt when config has changed', async () => {
    process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
    process.env.SYSTEM_EMBEDDER_MODEL = 'text-embedding-3-small';

    const existingAgent = makeEmbeddingAgent({
      name: 'system-embedder',
      systemPrompt: JSON.stringify({ provider: 'openai', model: 'text-embedding-ada-002', dimensions: 1536 }),
    });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(existingAgent) });

    await service.bootstrapSystemEmbedder('tenant-1', em);

    expect(existingAgent.systemPrompt).toContain('text-embedding-3-small');
    expect((em.flush as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('is idempotent: skips flush when config is unchanged', async () => {
    process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
    process.env.SYSTEM_EMBEDDER_MODEL = 'text-embedding-3-small';

    const currentConfig = JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
    const existingAgent = makeEmbeddingAgent({ name: 'system-embedder', systemPrompt: currentConfig });
    const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(existingAgent) });

    await service.bootstrapSystemEmbedder('tenant-1', em);

    expect((em.flush as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('skips creation when tenant is not found in DB', async () => {
    process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
    process.env.SYSTEM_EMBEDDER_MODEL = 'text-embedding-3-small';

    const em = buildMockEm({
      findOne: vi.fn()
        .mockResolvedValueOnce(null)  // agent not found
        .mockResolvedValueOnce(null), // tenant not found
    });

    await service.bootstrapSystemEmbedder('tenant-1', em);

    expect((em.persist as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── dimensionsForModel (via resolveEmbedder) ──────────────────────────────────

describe('dimensionsForModel (tested via resolveEmbedder)', () => {
  let service: EmbeddingAgentService;

  afterEach(() => {
    delete process.env.SYSTEM_EMBEDDER_PROVIDER;
    delete process.env.SYSTEM_EMBEDDER_MODEL;
  });

  beforeEach(() => {
    service = new EmbeddingAgentService();
  });

  const cases = [
    { model: 'text-embedding-3-small', expected: 1536 },
    { model: 'text-embedding-3-large', expected: 3072 },
    { model: 'text-embedding-ada-002', expected: 1536 },
    { model: 'unknown-model-xyz', expected: 1536 }, // default fallback
  ];

  for (const { model, expected } of cases) {
    it(`${model} → ${expected} dimensions`, async () => {
      process.env.SYSTEM_EMBEDDER_PROVIDER = 'openai';
      process.env.SYSTEM_EMBEDDER_MODEL = model;
      const em = buildMockEm();

      const config = await service.resolveEmbedder(undefined, 'tenant-1', em);

      expect(config.dimensions).toBe(expected);
    });
  }
});

// ── Settings provider ref fallback ──────────────────────────────────────────

describe('EmbeddingAgentService.resolveEmbedder — provider ref', () => {
  let service: EmbeddingAgentService;

  beforeEach(() => {
    service = new EmbeddingAgentService();
  });

  afterEach(() => {
    delete process.env.SYSTEM_EMBEDDER_PROVIDER;
    delete process.env.SYSTEM_EMBEDDER_MODEL;
    vi.clearAllMocks();
  });

  it('resolves config from gateway provider when defaultEmbedderProviderId is set', async () => {
    const settingsObj = {
      id: 1,
      defaultEmbedderProviderId: 'provider-uuid-1',
      defaultEmbedderModel: 'text-embedding-3-small',
      defaultEmbedderProvider: null,
      defaultEmbedderApiKey: null,
    };

    // Mock OpenAI provider entity
    const providerEntity = Object.create({ constructor: { name: 'OpenAIProvider' } });
    Object.assign(providerEntity, {
      id: 'provider-uuid-1',
      apiKey: 'sk-test-key-123',
      baseUrl: 'https://custom.openai.com',
    });
    // Set constructor name properly
    Object.defineProperty(providerEntity, 'constructor', { value: { name: 'OpenAIProvider' } });

    const em = buildMockEm({
      findOne: vi.fn()
        .mockResolvedValueOnce(settingsObj)   // Settings lookup
        .mockResolvedValueOnce(providerEntity), // ProviderBase lookup
    });

    const config = await service.resolveEmbedder(undefined, 'tenant-1', em);

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('text-embedding-3-small');
    expect(config.apiKey).toBe('sk-test-key-123');
    expect(config.baseUrl).toBe('https://custom.openai.com');
  });

  it('resolves Azure provider with deployment and apiVersion', async () => {
    const settingsObj = {
      id: 1,
      defaultEmbedderProviderId: 'provider-uuid-2',
      defaultEmbedderModel: 'text-embedding-3-small',
      defaultEmbedderProvider: null,
      defaultEmbedderApiKey: null,
    };

    const providerEntity = Object.create({});
    Object.assign(providerEntity, {
      id: 'provider-uuid-2',
      apiKey: 'azure-key-456',
      baseUrl: 'https://myresource.openai.azure.com',
      deployment: 'embedding-deployment',
      apiVersion: '2024-02-01',
    });
    Object.defineProperty(providerEntity, 'constructor', { value: { name: 'AzureProvider' } });

    const em = buildMockEm({
      findOne: vi.fn()
        .mockResolvedValueOnce(settingsObj)
        .mockResolvedValueOnce(providerEntity),
    });

    const config = await service.resolveEmbedder(undefined, 'tenant-1', em);

    expect(config.provider).toBe('azure');
    expect(config.apiKey).toBe('azure-key-456');
    expect(config.deployment).toBe('embedding-deployment');
    expect(config.apiVersion).toBe('2024-02-01');
    expect(config.baseUrl).toBe('https://myresource.openai.azure.com');
  });

  it('throws when referenced provider no longer exists', async () => {
    const settingsObj = {
      id: 1,
      defaultEmbedderProviderId: 'deleted-provider-id',
      defaultEmbedderModel: 'text-embedding-3-small',
      defaultEmbedderProvider: null,
      defaultEmbedderApiKey: null,
    };

    const em = buildMockEm({
      findOne: vi.fn()
        .mockResolvedValueOnce(settingsObj)  // Settings
        .mockResolvedValueOnce(null),         // Provider not found
    });

    await expect(service.resolveEmbedder(undefined, 'tenant-1', em))
      .rejects.toThrow('no longer exists');
  });

  it('falls back to legacy fields when no provider ref', async () => {
    const settingsObj = {
      id: 1,
      defaultEmbedderProviderId: null,
      defaultEmbedderModel: 'text-embedding-3-small',
      defaultEmbedderProvider: 'openai',
      defaultEmbedderApiKey: 'legacy-key',
    };

    const em = buildMockEm({
      findOne: vi.fn().mockResolvedValueOnce(settingsObj),
    });

    const config = await service.resolveEmbedder(undefined, 'tenant-1', em);

    expect(config.provider).toBe('openai');
    expect(config.apiKey).toBe('legacy-key');
    expect(config.baseUrl).toBeUndefined();
  });
});

// ── embedTexts validation ──────────────────────────────────────────────────

describe('embedTexts', () => {
  let service: EmbeddingAgentService;

  beforeEach(() => {
    service = new EmbeddingAgentService();
  });

  it('throws when Azure provider has no baseUrl', async () => {
    await expect(
      service.embedTexts(['hello'], {
        provider: 'azure',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        apiKey: 'key',
        baseUrl: undefined,
      }),
    ).rejects.toThrow('Azure embedding provider requires a baseUrl');
  });

  it('throws when Azure provider has empty baseUrl', async () => {
    await expect(
      service.embedTexts(['hello'], {
        provider: 'azure',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        apiKey: 'key',
        baseUrl: '',
      }),
    ).rejects.toThrow('Azure embedding provider requires a baseUrl');
  });
});
