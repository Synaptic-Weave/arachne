import type { EntityManager } from '@mikro-orm/core';

export interface VectorSearchRow {
  id: string;
  content: string;
  source_path: string | null;
  similarity_score: string;
}

/**
 * Encapsulates pgvector similarity search queries.
 * Uses raw SQL via Knex because pgvector operators (<=>) are not
 * expressible through MikroORM's QueryBuilder.
 */
export class VectorSearchRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Find the top-K most similar chunks for a given vector.
   *
   * @param artifactId - The artifact (knowledge base) to search within.
   * @param vectorLiteral - pgvector literal string, e.g. "[0.1,0.2,0.3]".
   * @param topK - Maximum number of results to return.
   */
  async similaritySearch(
    artifactId: string,
    vectorLiteral: string,
    topK: number,
  ): Promise<VectorSearchRow[]> {
    const knex = (this.em as any).getKnex();
    const sql = `
      SELECT id, content, source_path,
             1 - (embedding <=> ?::vector) AS similarity_score
      FROM kb_chunks
      WHERE artifact_id = ?
      ORDER BY embedding <=> ?::vector
      LIMIT ?
    `;
    const result = await knex.raw(sql, [vectorLiteral, artifactId, vectorLiteral, topK]);
    return result.rows as VectorSearchRow[];
  }
}
