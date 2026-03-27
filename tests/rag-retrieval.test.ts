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

// Mock VectorSearchRepository to intercept pgvector queries
vi.mock('../src/domain/repositories/VectorSearchRepository.js', () => ({
  VectorSearchRepository: vi.fn(),
}));

import { retrieveChunks, buildRagContext } from '../src/rag/retrieval.js';
import { EmbeddingAgentService } from '../src/services/EmbeddingAgentService.js';
import { VectorSearchRepository } from '../src/domain/repositories/VectorSearchRepository.js';

const MOCK_EMBED_CONFIG = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  apiKey: 'sk-test',
};

function buildMockEm(countValue = 0): EntityManager {
  return {
    count: vi.fn().mockResolvedValue(countValue),
    getKnex: () => ({ raw: vi.fn() }),
  } as unknown as EntityManager;
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
  let mockVectorSearchInstance: { similaritySearch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockEmbedderInstance = { resolveEmbedder: vi.fn().mockResolvedValue(MOCK_EMBED_CONFIG) };
    vi.mocked(EmbeddingAgentService).mockImplementation(() => mockEmbedderInstance as any);

    mockVectorSearchInstance = { similaritySearch: vi.fn().mockResolvedValue([]) };
    vi.mocked(VectorSearchRepository).mockImplementation(() => mockVectorSearchInstance as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns top-K chunks with correct shape', async () => {
    const rows = [
      { id: 'chunk-1', content: 'Hello world', source_path: 'docs/hello.md', similarity_score: '0.95' },
      { id: 'chunk-2', content: 'Goodbye world', source_path: null, similarity_score: '0.80' },
    ];
    mockVectorSearchInstance.similaritySearch.mockResolvedValue(rows);
    global.fetch = mockFetchEmbedding([0.1, 0.2, 0.3]) as any;
    const em = buildMockEm(2);

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
    const em = buildMockEm(0);

    const result = await retrieveChunks('nothing matches', 'artifact-1', 5, 'tenant-1', undefined, em);

    expect(result.chunks).toHaveLength(0);
    expect(result.embeddingLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('formats pgvector query with correct vector literal [x,y,z]', async () => {
    const embedding = [0.1, 0.2, 0.3];
    global.fetch = mockFetchEmbedding(embedding) as any;
    const em = buildMockEm(0);

    await retrieveChunks('query', 'artifact-42', 3, 'tenant-1', undefined, em);

    // VectorSearchRepository.similaritySearch should be called with correct args
    expect(mockVectorSearchInstance.similaritySearch).toHaveBeenCalledWith(
      'artifact-42',
      '[0.1,0.2,0.3]',
      3,
    );
  });

  it('passes agentRef to embedder resolver', async () => {
    global.fetch = mockFetchEmbedding([0.5]) as any;
    const em = buildMockEm(0);

    await retrieveChunks('q', 'artifact-1', 1, 'tenant-1', 'my-embedder', em);

    expect(mockEmbedderInstance.resolveEmbedder).toHaveBeenCalledWith('my-embedder', 'tenant-1', em);
  });

  it('throws when embedder resolution fails', async () => {
    mockEmbedderInstance.resolveEmbedder.mockRejectedValue(
      new Error('EmbeddingAgent \'missing-agent\' not found for tenant tenant-1'),
    );
    const em = buildMockEm(0);

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
    const em = buildMockEm(0);

    await expect(
      retrieveChunks('q', 'artifact-1', 5, 'tenant-1', undefined, em),
    ).rejects.toThrow('Embedding API error 401');
  });

  it('calls em.count() to check chunk count', async () => {
    global.fetch = mockFetchEmbedding([0.1]) as any;
    const em = buildMockEm(42);

    await retrieveChunks('q', 'artifact-1', 5, 'tenant-1', undefined, em);

    expect(em.count).toHaveBeenCalledWith(expect.anything(), { artifact: 'artifact-1' });
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
