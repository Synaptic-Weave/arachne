import { OpenAIProvider } from './openai.js';
import { AzureProvider } from './azure.js';
import type { BaseProvider } from './base.js';
import type { TenantContext } from '../auth.js';
import { decryptTraceBody } from '../encryption.js';

// Lazy-initialised provider instances.
// Primary key: agentId (when available) or tenantId.
// Secondary index: tenantId → Set of cache keys (for bulk eviction by tenant).
const providerCache = new Map<string, BaseProvider>();
const tenantIndex = new Map<string, Set<string>>(); // tenantId → cache keys

/**
 * Cache a provider instance under cacheKey and register it in the tenant index.
 */
function cacheProvider(cacheKey: string, tenantId: string, provider: BaseProvider): BaseProvider {
  providerCache.set(cacheKey, provider);
  const keys = tenantIndex.get(tenantId) ?? new Set<string>();
  keys.add(cacheKey);
  tenantIndex.set(tenantId, keys);
  return provider;
}

/**
 * Return the correct provider instance for a tenant.
 *
 * Resolution order:
 * 1. Cache hit — return immediately
 * 2. Entity-first path — if `tenantCtx.providerEntity` exists (loaded by TenantService),
 *    delegate to `entity.createClient(tenantId)`
 * 3. Legacy JSONB path — fall back to `tenantCtx.providerConfig` fields
 *
 * API keys stored in provider_config may be encrypted with format:
 *   "encrypted:{ciphertext}:{iv}"
 */
export function getProviderForTenant(tenantCtx: TenantContext): BaseProvider {
  const cacheKey = tenantCtx.agentId ?? tenantCtx.tenantId;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  // ── Entity-first path ──────────────────────────────────────────────────────
  if (tenantCtx.providerEntity && typeof tenantCtx.providerEntity.createClient === 'function') {
    const provider = tenantCtx.providerEntity.createClient(tenantCtx.tenantId);
    return cacheProvider(cacheKey, tenantCtx.tenantId, provider);
  }

  // ── Legacy JSONB path ──────────────────────────────────────────────────────
  const cfg = tenantCtx.providerConfig;
  let provider: BaseProvider;

  // Decrypt API key if encrypted
  let apiKey = cfg?.apiKey;
  if (apiKey && apiKey.startsWith('encrypted:')) {
    try {
      const parts = apiKey.split(':');
      if (parts.length === 3) {
        const ciphertext = parts[1];
        const iv = parts[2];
        apiKey = decryptTraceBody(tenantCtx.tenantId, ciphertext, iv);
      }
    } catch (err) {
      // Log error but fall through - provider will fail auth downstream
      console.error('Failed to decrypt provider API key for tenant', tenantCtx.tenantId, err);
      apiKey = '';
    }
  }

  if (cfg?.provider === 'azure') {
    provider = new AzureProvider({
      apiKey:      apiKey ?? '',
      endpoint:    cfg.baseUrl ?? '',
      deployment:  cfg.deployment ?? '',
      apiVersion:  cfg.apiVersion ?? '2024-02-01',
      deploymentMap: cfg.deploymentMap,
    });
  } else if (cfg?.provider === 'ollama') {
    provider = new OpenAIProvider({
      apiKey:   'ollama', // Ollama ignores the key but the client requires a non-empty value
      baseUrl:  (cfg.baseUrl ?? 'http://localhost:11434') + '/v1',
    });
  } else {
    provider = new OpenAIProvider({
      apiKey:   apiKey ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl:  cfg?.baseUrl,
    });
  }

  return cacheProvider(cacheKey, tenantCtx.tenantId, provider);
}

/**
 * Evict all cached provider instances associated with a tenant.
 * Pass a tenantId to clear all agents; pass an agentId to clear one specific agent.
 */
export function evictProvider(id: string): void {
  // Try as a direct cache key first (agentId or legacy tenantId key).
  if (providerCache.has(id)) {
    providerCache.delete(id);
  }
  // Also clear all cache keys registered under this tenantId.
  const keys = tenantIndex.get(id);
  if (keys) {
    for (const k of keys) {
      providerCache.delete(k);
    }
    tenantIndex.delete(id);
  }
}
