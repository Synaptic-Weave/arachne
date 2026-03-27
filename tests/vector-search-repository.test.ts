/**
 * VectorSearchRepository unit tests
 *
 * Tests the VectorSearchRepository class that wraps pgvector similarity search.
 * Mocks EntityManager with getKnex() returning a fake Knex instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityManager } from '@mikro-orm/core';
import {
  VectorSearchRepository,
  type VectorSearchRow,
} from '../src/domain/repositories/VectorSearchRepository.js';

// ── Mock Knex factory ───────────────────────────────────────────────────────

const mockRaw = vi.fn();

function buildMockEm(): EntityManager {
  return {
    getKnex: () => ({ raw: mockRaw }),
  } as unknown as EntityManager;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('VectorSearchRepository', () => {
  let repo: VectorSearchRepository;

  beforeEach(() => {
    mockRaw.mockReset();
    repo = new VectorSearchRepository(buildMockEm());
  });

  it('accepts an EntityManager in the constructor', () => {
    expect(repo).toBeInstanceOf(VectorSearchRepository);
  });

  describe('similaritySearch', () => {
    it('calls knex.raw with pgvector cosine distance SQL', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });

      await repo.similaritySearch('artifact-1', '[0.1,0.2,0.3]', 5);

      expect(mockRaw).toHaveBeenCalledTimes(1);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('<=>');
      expect(calledSql).toContain('::vector');
      expect(calledSql).toContain('similarity_score');
      expect(calledSql).toContain('kb_chunks');
    });

    it('passes correct parameters (vectorLiteral, artifactId, vectorLiteral, topK)', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });

      await repo.similaritySearch('artifact-xyz', '[0.5,0.6]', 10);

      const params = mockRaw.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['[0.5,0.6]', 'artifact-xyz', '[0.5,0.6]', 10]);
    });

    it('returns properly typed VectorSearchRow[]', async () => {
      const mockRows: VectorSearchRow[] = [
        { id: 'chunk-1', content: 'First chunk content', source_path: '/doc.md', similarity_score: '0.92' },
        { id: 'chunk-2', content: 'Second chunk content', source_path: null, similarity_score: '0.85' },
      ];
      mockRaw.mockResolvedValueOnce({ rows: mockRows });

      const result = await repo.similaritySearch('artifact-1', '[0.1,0.2]', 5);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual<VectorSearchRow>({
        id: 'chunk-1',
        content: 'First chunk content',
        source_path: '/doc.md',
        similarity_score: '0.92',
      });
      expect(result[1]).toEqual<VectorSearchRow>({
        id: 'chunk-2',
        content: 'Second chunk content',
        source_path: null,
        similarity_score: '0.85',
      });
    });

    it('returns empty array when no matches', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });

      const result = await repo.similaritySearch('artifact-1', '[0.1]', 3);

      expect(result).toEqual([]);
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('pgvector extension not installed'));

      await expect(
        repo.similaritySearch('artifact-1', '[0.1,0.2]', 5),
      ).rejects.toThrow('pgvector extension not installed');
    });

    it('uses Knex ? placeholders (not $N)', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });

      await repo.similaritySearch('artifact-1', '[0.1]', 3);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      // VectorSearchRepository uses ? directly (unlike AnalyticsRepository which converts $N)
      expect(calledSql).toContain('?');
    });
  });
});
