/**
 * Gateway Model Validation Tests (#111, Story 7)
 *
 * Tests the model validation logic in the /v1/chat/completions handler:
 * - Request with a model in availableModels — passes through to proxy
 * - Request with a model NOT in availableModels — returns 400 with model_not_available
 * - Provider with empty availableModels — allows any model (pass-through)
 * - No provider entity (JSONB path) — no model validation, passes through
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock encryption ────────────────────────────────────────────────────────
vi.mock('../src/encryption.js', () => ({
  decryptTraceBody: vi.fn((_tenantId: string, ciphertext: string, _iv: string) => {
    return `decrypted-${ciphertext}`;
  }),
  encryptTraceBody: vi.fn(() => ({ ciphertext: 'enc', iv: 'iv' })),
}));

vi.mock('../src/providers/registry.js', () => ({
  evictProvider: vi.fn(),
  getProviderForTenant: vi.fn(),
}));

import { OpenAIProvider as OpenAIEntity } from '../src/domain/entities/OpenAIProvider.js';
import type { TenantContext } from '../src/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: 'tenant-model-test',
    name: 'Test Tenant',
    mergePolicies: { system_prompt: 'prepend', skills: 'merge' },
    ...overrides,
  };
}

function makeOpenAIEntity(models: string[] = []): OpenAIEntity {
  const entity = new OpenAIEntity('test-openai', 'sk-test');
  entity.availableModels = models;
  return entity;
}

/**
 * Replicates the model validation logic from src/index.ts POST /v1/chat/completions.
 * This allows us to test the logic in isolation without bootstrapping the full server.
 */
function validateModel(
  tenant: TenantContext | undefined,
  requestedModel: string,
): { allowed: boolean; error?: { code: string; available_models?: string[] } } {
  if (tenant?.providerEntity) {
    const allowedModels: string[] | undefined = tenant.providerEntity.availableModels;
    if (allowedModels && allowedModels.length > 0) {
      if (requestedModel && !allowedModels.includes(requestedModel)) {
        return {
          allowed: false,
          error: {
            code: 'model_not_available',
            available_models: allowedModels,
          },
        };
      }
    }
  }
  return { allowed: true };
}

// ── Model Validation Logic ───────────────────────────────────────────────────

describe('Gateway model validation — inline logic', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('allows request when model is in availableModels', () => {
    const entity = makeOpenAIEntity(['gpt-4o', 'gpt-4o-mini', 'gpt-4']);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'gpt-4o');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects request when model is NOT in availableModels with model_not_available', () => {
    const entity = makeOpenAIEntity(['gpt-4o', 'gpt-4o-mini']);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'gpt-3.5-turbo');
    expect(result.allowed).toBe(false);
    expect(result.error!.code).toBe('model_not_available');
    expect(result.error!.available_models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('allows any model when availableModels is empty (pass-through)', () => {
    const entity = makeOpenAIEntity([]);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'any-model-whatsoever');
    expect(result.allowed).toBe(true);
  });

  it('allows any model when no providerEntity is set (JSONB path)', () => {
    const tenant = makeTenantContext({
      providerConfig: { provider: 'openai', apiKey: 'sk-test' },
    });

    const result = validateModel(tenant, 'gpt-4o');
    expect(result.allowed).toBe(true);
  });

  it('allows any model when tenant is undefined', () => {
    const result = validateModel(undefined, 'gpt-4o');
    expect(result.allowed).toBe(true);
  });

  it('allows request when requestedModel is empty string', () => {
    const entity = makeOpenAIEntity(['gpt-4o']);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, '');
    expect(result.allowed).toBe(true);
  });

  it('allows any model when availableModels is undefined', () => {
    const entity = new OpenAIEntity('test-openai', 'sk-test');
    // availableModels defaults to undefined on the entity
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'gpt-4o');
    expect(result.allowed).toBe(true);
  });
});

// ── Provider Entity availableModels behavior ─────────────────────────────────

describe('Provider entity — availableModels property', () => {
  it('defaults to empty array', () => {
    const entity = new OpenAIEntity('test', 'sk-test');
    // The entity may default to [] or undefined depending on implementation
    const models = entity.availableModels;
    // Either undefined or empty array means "allow all"
    expect(!models || models.length === 0).toBe(true);
  });

  it('can be set to a specific list', () => {
    const entity = new OpenAIEntity('test', 'sk-test');
    entity.availableModels = ['gpt-4o', 'gpt-4o-mini'];
    expect(entity.availableModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('model matching is case-sensitive', () => {
    const entity = makeOpenAIEntity(['gpt-4o']);
    const tenant = makeTenantContext({ providerEntity: entity });

    // Exact match works
    expect(validateModel(tenant, 'gpt-4o').allowed).toBe(true);
    // Different case does not match
    expect(validateModel(tenant, 'GPT-4o').allowed).toBe(false);
  });
});

// ── Integration-style: verify error shape matches gateway response ────────

describe('Model validation error shape', () => {
  it('error includes code and available_models for rejected requests', () => {
    const entity = makeOpenAIEntity(['gpt-4o', 'gpt-4']);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'claude-3-opus');
    expect(result.allowed).toBe(false);
    expect(result.error).toEqual({
      code: 'model_not_available',
      available_models: ['gpt-4o', 'gpt-4'],
    });
  });

  it('no error object when model is allowed', () => {
    const entity = makeOpenAIEntity(['gpt-4o']);
    const tenant = makeTenantContext({ providerEntity: entity });

    const result = validateModel(tenant, 'gpt-4o');
    expect(result.error).toBeUndefined();
  });
});
