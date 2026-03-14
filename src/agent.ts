/**
 * Agent context application and MCP round-trip handling for the Arachne gateway.
 *
 * Called from the /v1/chat/completions handler to:
 *   1. Inject agent system prompt and skills into the outgoing request body
 *      according to the agent's merge_policies.
 *   2. Detect MCP tool calls in a provider response and perform one round-trip
 *      to the MCP server(s), then re-send to the provider.
 */
import type { TenantContext } from './auth.js';
import type { BaseProvider } from './providers/base.js';
import type { ProxyRequest } from './types/openai.js';
import type { EntityManager } from '@mikro-orm/core';
import { Artifact } from './domain/entities/Artifact.js';
import { retrieveChunks, buildRagContext } from './rag/retrieval.js';

// ---------------------------------------------------------------------------
// RAG context injection
// ---------------------------------------------------------------------------

export interface RagSource {
  rank: number;
  sourcePath?: string;
  similarityScore: number;
  contentPreview: string;
}

export interface RagInjectionResult {
  knowledgeBaseId?: string;
  ragRetrievalLatencyMs?: number;
  embeddingLatencyMs?: number;
  vectorSearchLatencyMs?: number;
  retrievedChunkCount?: number;
  topChunkSimilarity?: number;
  avgChunkSimilarity?: number;
  ragStageFailed?: string;
  fallbackToNoRag?: boolean;
  sources?: RagSource[];
}

const RAG_TOP_K = 5;

/**
 * If the agent has a `knowledgeBaseRef`, embed the user query, retrieve top-K
 * chunks from the KB, and inject a RAG context block at the start of the
 * system prompt.  Never throws — RAG failures are logged and the request
 * continues without RAG context.
 */
export async function injectRagContext(
  body: any,
  tenant: TenantContext,
  em: EntityManager,
): Promise<{ body: any; ragResult: RagInjectionResult }> {
  if (!tenant.knowledgeBaseRef) {
    console.log(`[rag] no knowledgeBaseRef on tenant context — skipping RAG`);
    return { body, ragResult: {} };
  }

  console.log(`[rag] resolving KB artifact '${tenant.knowledgeBaseRef}' for tenant ${tenant.tenantId}`);

  // Resolve KB artifact by name for this tenant
  let artifact: Artifact | null = null;
  try {
    artifact = await em.findOne(Artifact, {
      name: tenant.knowledgeBaseRef,
      tenant: tenant.tenantId,
      kind: 'KnowledgeBase',
    });
  } catch (err) {
    console.error('[rag] failed to resolve KB artifact:', err);
    return { body, ragResult: { ragStageFailed: 'retrieval', fallbackToNoRag: true } };
  }

  if (!artifact) {
    console.warn(`[rag] KB artifact '${tenant.knowledgeBaseRef}' not found for tenant ${tenant.tenantId}`);
    return { body, ragResult: { ragStageFailed: 'retrieval', fallbackToNoRag: true } };
  }

  console.log(`[rag] found artifact id=${artifact.id}, chunkCount=${(artifact as any).chunkCount ?? '?'}`);

  // Extract user query from the last user message
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user');
  const queryText: string =
    typeof lastUserMessage?.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage?.content ?? '');

  if (!queryText) {
    console.log('[rag] no user message found — skipping retrieval');
    return { body, ragResult: { ragStageFailed: 'none', fallbackToNoRag: false } };
  }

  console.log(`[rag] query: "${queryText.substring(0, 100)}${queryText.length > 100 ? '…' : ''}"`);

  // Retrieve chunks
  let retrievalResult;
  try {
    retrievalResult = await retrieveChunks(
      queryText,
      artifact.id,
      RAG_TOP_K,
      tenant.tenantId,
      undefined, // use system embedder
      em,
    );
  } catch (err) {
    console.error('[rag] retrieval failed:', err);
    const stage =
      String(err).includes('Embedding API') ? 'embedding' : 'retrieval';
    return {
      body,
      ragResult: {
        knowledgeBaseId: artifact.id,
        ragStageFailed: stage,
        fallbackToNoRag: true,
      },
    };
  }

  const { chunks, embeddingLatencyMs, vectorSearchLatencyMs, totalRagLatencyMs } = retrievalResult;

  console.log(`[rag] retrieved ${chunks.length} chunks in ${totalRagLatencyMs}ms (embed: ${embeddingLatencyMs}ms, search: ${vectorSearchLatencyMs}ms)`);
  for (const chunk of chunks) {
    console.log(`[rag]   [${chunk.rank}] score=${chunk.similarityScore.toFixed(4)} source=${chunk.sourcePath ?? '-'} content="${chunk.content.substring(0, 80)}…"`);
  }

  if (chunks.length === 0) {
    console.warn('[rag] no chunks returned from vector search');
    return {
      body,
      ragResult: {
        knowledgeBaseId: artifact.id,
        ragRetrievalLatencyMs: totalRagLatencyMs,
        embeddingLatencyMs,
        vectorSearchLatencyMs,
        retrievedChunkCount: 0,
        ragStageFailed: 'none',
        fallbackToNoRag: false,
      },
    };
  }

  // Build and inject RAG context
  let augmentedBody: any;
  try {
    const ragContext = buildRagContext(chunks);
    const msgs: any[] = Array.isArray(body.messages) ? [...body.messages] : [];
    const systemIdx = msgs.findIndex((m: any) => m.role === 'system');
    if (systemIdx >= 0) {
      msgs[systemIdx] = {
        ...msgs[systemIdx],
        content: ragContext + '\n\n' + msgs[systemIdx].content,
      };
    } else {
      msgs.unshift({ role: 'system', content: ragContext });
    }
    augmentedBody = { ...body, messages: msgs };
  } catch (err) {
    console.error('[rag] context injection failed:', err);
    return {
      body,
      ragResult: {
        knowledgeBaseId: artifact.id,
        ragRetrievalLatencyMs: totalRagLatencyMs,
        embeddingLatencyMs,
        vectorSearchLatencyMs,
        retrievedChunkCount: chunks.length,
        ragStageFailed: 'injection',
        fallbackToNoRag: true,
      },
    };
  }

  const scores = chunks.map((c) => c.similarityScore);
  const topChunkSimilarity = Math.max(...scores);
  const avgChunkSimilarity = scores.reduce((a, b) => a + b, 0) / scores.length;

  return {
    body: augmentedBody,
    ragResult: {
      knowledgeBaseId: artifact.id,
      ragRetrievalLatencyMs: totalRagLatencyMs,
      embeddingLatencyMs,
      vectorSearchLatencyMs,
      retrievedChunkCount: chunks.length,
      topChunkSimilarity,
      avgChunkSimilarity,
      ragStageFailed: 'none',
      fallbackToNoRag: false,
      sources: chunks.map(c => ({
        rank: c.rank,
        sourcePath: c.sourcePath,
        similarityScore: c.similarityScore,
        contentPreview: c.content.substring(0, 150),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// applyAgentToRequest
// ---------------------------------------------------------------------------

/**
 * Return a new request body with the agent's system prompt and skills applied
 * according to `tenant.mergePolicies`.  The original body is never mutated.
 */
export function applyAgentToRequest(body: any, tenant: TenantContext): any {
  const result = { ...body };
  const messages: any[] = Array.isArray(result.messages) ? [...result.messages] : [];
  const policy = tenant.mergePolicies;

  // ── System prompt injection ──────────────────────────────────────────────
  if (tenant.resolvedSystemPrompt) {
    const mode = policy.system_prompt ?? 'prepend';

    if (mode === 'prepend') {
      result.messages = [
        { role: 'system', content: tenant.resolvedSystemPrompt },
        ...messages,
      ];
    } else if (mode === 'append') {
      result.messages = [
        ...messages,
        { role: 'system', content: tenant.resolvedSystemPrompt },
      ];
    } else if (mode === 'overwrite') {
      result.messages = [
        { role: 'system', content: tenant.resolvedSystemPrompt },
        ...messages.filter((m: any) => m.role !== 'system'),
      ];
    }
    // 'ignore': leave messages unchanged
  }

  // ── Skills (tools) injection ─────────────────────────────────────────────
  if (tenant.resolvedSkills && tenant.resolvedSkills.length > 0) {
    const mode = policy.skills ?? 'merge';

    if (mode === 'overwrite') {
      result.tools = tenant.resolvedSkills;
    } else if (mode === 'merge') {
      const existing: any[] = result.tools ?? [];
      const agentNames = new Set(
        tenant.resolvedSkills.map((s: any) => s.function?.name ?? s.name),
      );
      const deduped = existing.filter(
        (t: any) => !agentNames.has(t.function?.name ?? t.name),
      );
      result.tools = [...tenant.resolvedSkills, ...deduped];
    }
    // 'ignore': leave tools unchanged
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleMcpRoundTrip
// ---------------------------------------------------------------------------

/**
 * If the provider response contains tool_calls whose names match registered
 * MCP endpoints on the agent, call those endpoints, inject tool results, and
 * re-send to the provider — one round-trip maximum.
 *
 * Only applies to non-streaming (JSON) responses.
 * Returns `{ body, didCallMcp }`.
 */
export async function handleMcpRoundTrip(
  requestBody: any,
  responseBody: any,
  tenant: TenantContext,
  provider: BaseProvider,
  proxyReq: ProxyRequest,
): Promise<{ body: any; didCallMcp: boolean }> {
  const toolCalls: any[] | undefined =
    responseBody?.choices?.[0]?.message?.tool_calls;

  if (!toolCalls?.length || !tenant.resolvedMcpEndpoints?.length) {
    return { body: responseBody, didCallMcp: false };
  }

  const endpointMap = new Map<string, any>(
    tenant.resolvedMcpEndpoints.map((ep: any) => [ep.name, ep]),
  );

  const mcpCalls = toolCalls.filter((tc: any) =>
    endpointMap.has(tc.function?.name),
  );
  if (!mcpCalls.length) {
    return { body: responseBody, didCallMcp: false };
  }

  // Call all matching MCP endpoints in parallel
  const toolResults = await Promise.all(
    mcpCalls.map(async (tc: any) => {
      const endpoint = endpointMap.get(tc.function.name)!;
      let args: unknown;
      try {
        args =
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
      } catch {
        args = {};
      }

      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: tc.function.name, arguments: args },
            id: tc.id,
          }),
        });
        const data = (await res.json()) as any;
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: JSON.stringify(data.result ?? data),
        };
      } catch (err) {
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'MCP call failed',
            detail: String(err),
          }),
        };
      }
    }),
  );

  // Re-send with updated messages: original messages + assistant reply + tool results
  const updatedMessages = [
    ...requestBody.messages,
    responseBody.choices[0].message,
    ...toolResults,
  ];

  const followUpReq: ProxyRequest = {
    ...proxyReq,
    body: { ...requestBody, messages: updatedMessages },
  };

  const followUp = await provider.proxy(followUpReq);
  return { body: followUp.body, didCallMcp: true };
}
