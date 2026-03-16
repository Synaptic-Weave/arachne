import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EntityManager } from '@mikro-orm/core';
import { TenantService } from './application/services/TenantService.js';

export interface TenantProviderConfig {
  provider: 'openai' | 'azure' | 'ollama';
  apiKey: string;
  baseUrl?: string;       // OpenAI base URL or Azure endpoint
  deployment?: string;    // Azure deployment name
  apiVersion?: string;    // Azure API version (e.g. 2024-02-01)
  gatewayProviderId?: string; // Reference to a gateway provider entity
  deploymentMap?: Record<string, string>; // Azure: model name → deployment name
}

export interface MergePolicy {
  system_prompt?: 'prepend' | 'append' | 'overwrite' | 'ignore';
  skills?: 'merge' | 'overwrite' | 'ignore';
}

export interface AgentConfig {
  conversations_enabled?: boolean;
  conversation_token_limit?: number;
  conversation_summary_model?: string | null;
}

export interface TenantContext {
  tenantId: string;
  name: string;
  /** Resolved provider config: agent → tenant → parent chain → ENV fallback. */
  providerConfig?: TenantProviderConfig;
  /** ID of the agent bound to the API key used for this request. */
  agentId?: string;
  /** Raw agent system prompt (before any merge). */
  agentSystemPrompt?: string;
  /** Raw agent skills (OpenAI tool objects). */
  agentSkills?: any[];
  /** Raw agent MCP endpoint definitions. */
  agentMcpEndpoints?: any[];
  /** KB artifact name bound to the agent for RAG retrieval. */
  knowledgeBaseRef?: string;
  /** Merge policies controlling how agent config is applied to requests. */
  mergePolicies: MergePolicy;
  /** Chain-resolved system prompt (agent → tenant → parent…). */
  resolvedSystemPrompt?: string;
  /** Chain-resolved skills union (agent skills take precedence on name conflict). */
  resolvedSkills?: any[];
  /** Chain-resolved MCP endpoints union. */
  resolvedMcpEndpoints?: any[];
  /** Agent-level configuration (conversations, token limits, etc.). */
  agentConfig?: AgentConfig;
}

// Augment Fastify request type with tenant context
declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

// Simple LRU cache backed by an insertion-ordered Map.
// On access, entries are moved to the tail; on overflow, the head is evicted.
class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first/oldest entry)
      this.map.delete(this.map.keys().next().value as K);
    }
    this.map.set(key, value);
  }

  invalidate(key: K): void {
    this.map.delete(key);
  }
}

// Shared cache — 1 000 tenants; adjust if tenant count grows significantly
const tenantCache = new LRUCache<string, TenantContext>(1000);

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Register tenant auth middleware on the Fastify instance.
 *
 * - Validates the incoming API key (Authorization: Bearer <key> or x-api-key header)
 * - Checks an LRU cache before hitting the database to stay well under the 20ms overhead budget
 * - Attaches the resolved TenantContext to request.tenant for downstream handlers
 * - Skips auth for /health and /dashboard/* routes
 */
export function registerAuthMiddleware(fastify: FastifyInstance, em: EntityManager): void {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Public routes — no auth required
    // Skip tenant API key auth for /v1/admin routes (they use JWT auth)
    if (request.url === '/health' || request.url === '/favicon.ico' || request.url.startsWith('/dashboard') || request.url.startsWith('/v1/admin') || request.url.startsWith('/v1/portal') || request.url.startsWith('/v1/beta') || request.url.startsWith('/v1/registry') || !request.url.startsWith('/v1/')) {
      return;
    }

    // Accept key from Authorization: Bearer <key> or x-api-key header
    const authHeader = request.headers['authorization'];
    const xApiKey = request.headers['x-api-key'];

    let rawKey: string | undefined;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      rawKey = authHeader.slice(7).trim();
    } else if (typeof xApiKey === 'string') {
      rawKey = xApiKey.trim();
    }

    if (!rawKey) {
      return reply.code(401).send({
        error: {
          message: 'Missing API key. Provide it via "Authorization: Bearer <key>" or "x-api-key" header.',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    const keyHash = hashApiKey(rawKey);

    // LRU cache hit — no DB query needed
    let tenant = tenantCache.get(keyHash);

    if (!tenant) {
      let found: TenantContext | null = null;
      try {
        const tenantService = new TenantService(em);
        found = await tenantService.loadByApiKey(rawKey);
      } catch {
        // invalid key or inactive tenant
      }
      if (found) {
        tenantCache.set(keyHash, found);
        tenant = found;
      }
    }

    if (!tenant) {
      return reply.code(401).send({
        error: {
          message: 'Invalid API key.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    request.tenant = tenant;
  });
}

/**
 * Invalidate a single cached key lookup by its hash.
 * Use when an API key is revoked or its associated tenant is deactivated.
 */
export function invalidateCachedKey(keyHash: string): void {
  tenantCache.invalidate(keyHash);
}

/**
 * Invalidate all cached keys for a tenant.
 * Use when a tenant is deactivated to ensure all their keys are removed from cache.
 */
export async function invalidateAllKeysForTenant(tenantId: string, em: EntityManager): Promise<void> {
  const { ApiKey } = await import('./domain/entities/ApiKey.js');
  const keys = await em.find(ApiKey, { tenant: tenantId });
  for (const key of keys) {
    tenantCache.invalidate(key.keyHash);
  }
}
