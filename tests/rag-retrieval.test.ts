/**
 * Unit tests for src/rag/retrieval.ts
 * Covers: retrieveChunks, buildRagContext, embedder errors, pgvector query format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EntityManager } from '@mikro-orm/core';

// Mock EmbeddingAgentService before importing retrieval
vi.mock('../src/services/EmbeddingAgentService.js', () => ({
  EmbeddingAgentService: vi.fn(),
}));

import { retrieveChunks, buildRagContext } from '../src/rag/retrieval.js';
import { EmbeddingAgentService } from '../src/services/EmbeddingAgentService.js';

const MOCK_EMBED_CONFIG = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  apiKey: 'sk-test',
};

function buildMockKnex(rows: unknown[] = []) {
  return { raw: vi.fn().mockResolvedValue({ rows }) };
}

function buildEmWithKnex(rows: unknown[] = []): { em: EntityManager; knex: ReturnType<typeof buildMockKnex> } {
  const knex = buildMockKnex(rows);
  const em = { getKnex: () => knex } as unknown as EntityManager;
  return { em, knex };
}

function mockFetchEmbedding(embedding: number[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding }] }),
  });
}

// ── retrieveChunks ────────────────────────────────────────────────────────────

describe('retrieveChunks', () => {
  let mockEmbedderInstance: { resolveEmbedder: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockEmbedderInstance = { resolveEmbedder: vi.fn().mockResolvedValue(MOCK_EMBED_CONFIG) };
    vi.mocked(EmbeddingAgentService).mockImplementation(() => mockEmbedderInstance as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns top-K chunks with correct shape', async () => {
    const rows = [
      { id: 'chunk-1', content: 'Hello world', source_path: 'docs/hello.md', similarity_score: '0.95' },
      { id: 'chunk-2', content: 'Goodbye world', source_path: null, similarity_score: '0.80' },
    ];
    global.fetch = mockFetchEmbedding([0.1, 0.2, 0.3]) as any;
    const { em } = buildEmWithKnex(rows);

    const result = await retrieveChunks('test query', 'artifact-1', 2, 'tenant-1', undefined, em);

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toMatchObject({
      id: 'chunk-1',
      content: 'Hello world',
      sourcePath: 'docs/hello.md',
      similarityScore: 0.95,
      rank: 1,
    });
    expect(result.chunks[1]).toMatchObject({
      id: 'chunk-2',
      sourcePath: undefined,
      rank: 2,
    });
    expect(result.embeddingLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.vectorSearchLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.totalRagLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty chunks array when pgvector returns no rows', async () => {
    global.fetch = mockFetchEmbedding([0.1]) as any;
    const { em } = buildEmWithKnex([]);

    const result = await retrieveChunks('nothing matches', 'artifact-1', 5, 'tenant-1', undefined, em);

    expect(result.chunks).toHaveLength(0);
    expect(result.embeddingLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('formats pgvector query with correct vector literal [x,y,z]', async () => {
    const embedding = [0.1, 0.2, 0.3];
    global.fetch = mockFetchEmbedding(embedding) as any;
    const { em, knex } = buildEmWithKnex([]);

    await retrieveChunks('query', 'artifact-42', 3, 'tenant-1', undefined, em);

    // calls[0] is the chunk count query, calls[1] is the vector search
    const [, params] = (knex.raw as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(params[0]).toBe('[0.1,0.2,0.3]');  // pgvector literal
    expect(params[1]).toBe('artifact-42');       // artifact_id
    expect(params[2]).toBe('[0.1,0.2,0.3]');  // repeated for ORDER BY
    expect(params[3]).toBe(3);                   // LIMIT topK
  });

  it('passes agentRef to embedder resolver', async () => {
    global.fetch = mockFetchEmbedding([0.5]) as any;
    const { em } = buildEmWithKnex([]);

    await retrieveChunks('q', 'artifact-1', 1, 'tenant-1', 'my-embedder', em);

    expect(mockEmbedderInstance.resolveEmbedder).toHaveBeenCalledWith('my-embedder', 'tenant-1', em);
  });

  it('throws when embedder resolution fails', async () => {
    mockEmbedderInstance.resolveEmbedder.mockRejectedValue(
      new Error('EmbeddingAgent \'missing-agent\' not found for tenant tenant-1'),
    );
    const { em } = buildEmWithKnex([]);

    await expect(
      retrieveChunks('q', 'artifact-1', 5, 'tenant-1', 'missing-agent', em),
    ).rejects.toThrow('not found for tenant');
  });

  it('throws when embedding API returns non-OK status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as any;
    const { em } = buildEmWithKnex([]);

    await expect(
      retrieveChunks('q', 'artifact-1', 5, 'tenant-1', undefined, em),
    ).rejects.toThrow('Embedding API error 401');
  });
});

// ── buildRagContext ───────────────────────────────────────────────────────────

describe('buildRagContext', () => {
  it('returns empty string for empty chunks array', () => {
    expect(buildRagContext([])).toBe('');
  });

  it('formats citation block with header and footer', () => {
    const chunks = [
      { id: '1', content: 'First chunk', sourcePath: undefined, similarityScore: 0.9, rank: 1 },
    ];
    const result = buildRagContext(chunks);
    expect(result).toContain('--- Knowledge Base Context ---');
    expect(result).toContain('[1] First chunk');
    expect(result).toContain('Answer based on the above context. Cite sources as [1], [2], etc.');
  });

  it('appends source annotation when sourcePath is present', () => {
    const chunks = [
      { id: '1', content: 'Content here', sourcePath: 'docs/guide.md', similarityScore: 0.9, rank: 1 },
    ];
    const result = buildRagContext(chunks);
    expect(result).toContain('[1] Content here (source: docs/guide.md)');
  });

  it('omits source annotation when sourcePath is undefined', () => {
    const chunks = [
      { id: '1', content: 'No source', sourcePath: undefined, similarityScore: 0.8, rank: 1 },
    ];
    const result = buildRagContext(chunks);
    expect(result).toContain('[1] No source');
    expect(result).not.toContain('(source:');
  });

  it('handles special characters in chunk content', () => {
    const chunks = [
      {
        id: '1',
        content: 'Content with <tags> & "quotes" and \\backslash\nnewline',
        sourcePath: undefined,
        similarityScore: 0.7,
        rank: 1,
      },
    ];
    const result = buildRagContext(chunks);
    expect(result).toContain('<tags> & "quotes" and \\backslash');
  });

  it('numbers multiple chunks with correct ranks in order', () => {
    const chunks = [
      { id: '1', content: 'Alpha', sourcePath: undefined, similarityScore: 0.9, rank: 1 },
      { id: '2', content: 'Beta', sourcePath: 'b.md', similarityScore: 0.8, rank: 2 },
      { id: '3', content: 'Gamma', sourcePath: undefined, similarityScore: 0.7, rank: 3 },
    ];
    const result = buildRagContext(chunks);
    expect(result).toContain('[1] Alpha');
    expect(result).toContain('[2] Beta (source: b.md)');
    expect(result).toContain('[3] Gamma');
  });
});
