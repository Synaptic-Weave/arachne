import type { EntityManager } from '@mikro-orm/core';
import { EmbeddingAgentService } from '../services/EmbeddingAgentService.js';
import type { EmbeddingAgentConfig } from '../services/EmbeddingAgentService.js';

export interface RetrievedChunk {
  id: string;
  content: string;
  sourcePath?: string;
  similarityScore: number;
  rank: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  embeddingLatencyMs: number;
  vectorSearchLatencyMs: number;
  totalRagLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Internal: call embedding API to get query vector
// ---------------------------------------------------------------------------

async function embedQuery(text: string, config: EmbeddingAgentConfig): Promise<number[]> {
  let url: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: object;

  if (config.provider === 'azure') {
    const baseUrl = config.baseUrl ?? '';
    const deployment = config.deployment ?? config.model;
    const apiVersion = config.apiVersion ?? '2024-02-01';
    url = `${baseUrl}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
    headers['api-key'] = config.apiKey ?? '';
    body = { input: text };
  } else if (config.provider === 'ollama') {
    const baseUrl = config.baseUrl ?? 'http://localhost:11434';
    url = `${baseUrl}/api/embeddings`;
    body = { model: config.model, prompt: text };
  } else {
    // OpenAI or OpenAI-compatible
    const baseUrl = config.baseUrl ?? 'https://api.openai.com';
    url = `${baseUrl}/v1/embeddings`;
    headers['Authorization'] = `Bearer ${config.apiKey ?? ''}`;
    body = { model: config.model, input: text };
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

  // Ollama returns { embedding: [...] }, OpenAI/Azure return { data: [{ embedding: [...] }] }
  if (config.provider === 'ollama') {
    return data.embedding as number[];
  }
  return data.data[0].embedding as number[];
}

// ---------------------------------------------------------------------------
// retrieveChunks
// ---------------------------------------------------------------------------

/**
 * Retrieve top-K chunks from a knowledge base for a given query.
 * Uses pgvector cosine similarity search.
 */
export async function retrieveChunks(
  query: string,
  artifactId: string,
  topK: number,
  tenantId: string,
  embeddingAgentRef: string | undefined,
  em: EntityManager,
): Promise<RetrievalResult> {
  const ragStart = Date.now();

  // 1. Resolve embedder config
  const embeddingService = new EmbeddingAgentService();
  const embedConfig = await embeddingService.resolveEmbedder(embeddingAgentRef, tenantId, em);
  console.log(`[rag:retrieval] embedder resolved: provider=${embedConfig.provider} model=${embedConfig.model} baseUrl=${embedConfig.baseUrl ?? 'default'}`);

  // 2. Embed the query
  const embedStart = Date.now();
  const vector = await embedQuery(query, embedConfig);
  const embeddingLatencyMs = Date.now() - embedStart;
  console.log(`[rag:retrieval] query embedded in ${embeddingLatencyMs}ms, vector dimensions=${vector.length}`);

  // Format as pgvector literal: [0.1, 0.2, ...]
  const vectorLiteral = `[${vector.join(',')}]`;

  // 3. pgvector similarity search via raw SQL
  const sql = `
    SELECT id, content, source_path,
           1 - (embedding <=> ?::vector) AS similarity_score
    FROM kb_chunks
    WHERE artifact_id = ?
    ORDER BY embedding <=> ?::vector
    LIMIT ?
  `;

  // Check chunk count for this artifact
  const countResult = await (em as any).getKnex().raw(
    'SELECT COUNT(*) as cnt FROM kb_chunks WHERE artifact_id = ?', [artifactId]
  );
  const chunkCount = parseInt(countResult.rows?.[0]?.cnt ?? '0', 10);
  console.log(`[rag:retrieval] artifact ${artifactId} has ${chunkCount} chunks in kb_chunks table`);

  const searchStart = Date.now();
  const knex = (em as any).getKnex();
  const result = await knex.raw(sql, [vectorLiteral, artifactId, vectorLiteral, topK]);
  const vectorSearchLatencyMs = Date.now() - searchStart;
  console.log(`[rag:retrieval] vector search completed in ${vectorSearchLatencyMs}ms, ${result.rows?.length ?? 0} results`);

  const rows: Array<{
    id: string;
    content: string;
    source_path: string | null;
    similarity_score: string;
  }> = result.rows;

  const chunks: RetrievedChunk[] = rows.map((row, index) => ({
    id: row.id,
    content: row.content,
    sourcePath: row.source_path ?? undefined,
    similarityScore: parseFloat(row.similarity_score),
    rank: index + 1,
  }));

  return {
    chunks,
    embeddingLatencyMs,
    vectorSearchLatencyMs,
    totalRagLatencyMs: Date.now() - ragStart,
  };
}

// ---------------------------------------------------------------------------
// buildRagContext
// ---------------------------------------------------------------------------

/**
 * Build the RAG context string to inject into the system prompt.
 *
 * Format:
 *   --- Knowledge Base Context ---
 *   [1] {content} (source: {sourcePath})
 *   [2] {content}
 *   ---
 *   Answer based on the above context. Cite sources as [1], [2], etc.
 */
export function buildRagContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';

  const lines = chunks.map((chunk) => {
    const source = chunk.sourcePath ? ` (source: ${chunk.sourcePath})` : '';
    return `[${chunk.rank}] ${chunk.content}${source}`;
  });

  return [
    '--- Knowledge Base Context ---',
    ...lines,
    '---',
    'Answer based on the above context. Cite sources as [1], [2], etc.',
  ].join('\n');
}
