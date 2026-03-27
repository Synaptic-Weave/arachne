# Embedding Dimension Flexibility

> Tracked by Epic [#TBD]

## Status

Draft -- MVP Specification

------------------------------------------------------------------------

## Overview

Arachne's knowledge base storage layer currently hardcodes the embedding column as `vector(1536)`, which is the output dimensionality of OpenAI's `text-embedding-3-small` and `text-embedding-ada-002` models. This prevents tenants from using alternative embedding providers (such as Ollama with `nomic-embed-text`, which produces 768-dimensional vectors) because PostgreSQL's typed `vector(N)` column rejects any vector whose length does not match N.

The `vector_spaces` table already tracks embedding metadata (including a `dimensions` integer column, `model`, `provider`, and `embedding_agent_id`), and the CLI's weave command already detects actual embedding dimensions from the API response. However, the storage layer ignores this metadata entirely: the `kb_chunks.embedding` column enforces 1536 dimensions at the database level, and the IVFFlat index assumes a single fixed dimensionality.

This spec defines how to make the storage layer dimension-agnostic by switching to an untyped `vector` column with a `dimensions` integer discriminator, creating dimension-scoped partial HNSW indexes, and updating retrieval queries to group by dimension when an agent references multiple knowledge bases with different embedding models.

------------------------------------------------------------------------

## Design Goals

1. **Model-agnostic storage:** Accept embeddings of any dimensionality without schema changes per model.
2. **Indexed retrieval:** Maintain HNSW-accelerated similarity search via dimension-scoped partial indexes (no full table scans).
3. **Backward compatible:** Existing 1536-dimension knowledge bases continue to work without re-embedding or re-pushing.
4. **Self-managing indexes:** New dimension-scoped HNSW indexes are created automatically when a previously unseen dimensionality is pushed for the first time.
5. **Multi-KB aware:** When an agent references multiple KBs with different embedding models, retrieval groups chunks by dimension and issues separate embedding calls per group.
6. **Observable:** Dimension metadata is visible in traces, the registry list output, and the portal KB detail view.

------------------------------------------------------------------------

## Problem Statement

The current `kb_chunks` table definition (from migration `1000000000015_registry.cjs`) is:

```sql
embedding vector(1536)
```

This typed column causes PostgreSQL to reject `INSERT` statements where the vector length is not exactly 1536. When a tenant configures Ollama with `nomic-embed-text` (768 dimensions) or any other non-1536 model, the `arachne push` command succeeds through the HTTP layer but the database insert fails with a dimension mismatch error.

The IVFFlat index compounds the issue:

```sql
CREATE INDEX idx_kb_chunks_embedding ON kb_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

IVFFlat (and HNSW) indexes on typed `vector(N)` columns can only serve queries with matching-dimension vectors. An untyped `vector` column cannot be indexed with IVFFlat or HNSW directly because pgvector requires a known dimension at index creation time.

------------------------------------------------------------------------

## Solution Design

The solution uses three coordinated changes:

### 1. Untyped vector column with dimensions discriminator

Replace the typed `vector(1536)` column with an untyped `vector` column (accepts any dimension) and add a `dimensions` integer column as an explicit discriminator:

```
kb_chunks.embedding  -> vector        (untyped, accepts any dimension)
kb_chunks.dimensions -> integer       (NOT NULL, stores vector length)
```

The `dimensions` column enables:
- Partial index creation per dimension
- Query-time validation (only search chunks whose dimensions match the query vector)
- Multi-KB retrieval grouping

### 2. Dimension-scoped partial HNSW indexes

For each distinct dimension value present in the table, create a partial HNSW index using a cast expression:

```sql
CREATE INDEX idx_kb_chunks_embedding_1536
  ON kb_chunks
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE dimensions = 1536;

CREATE INDEX idx_kb_chunks_embedding_768
  ON kb_chunks
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WHERE dimensions = 768;
```

HNSW is preferred over IVFFlat because:
- HNSW does not require training (no `lists` parameter dependent on row count)
- HNSW handles concurrent inserts better
- HNSW provides more consistent recall at low row counts (common for per-tenant KBs)

### 3. Dimension-aware retrieval queries

The retrieval query in `src/rag/retrieval.ts` adds a `dimensions` filter and explicit cast:

```sql
SELECT id, content, source_path,
       1 - (embedding <=> ?::vector) AS similarity_score
FROM kb_chunks
WHERE artifact_id = ?
  AND dimensions = ?
ORDER BY embedding <=> ?::vector
LIMIT ?
```

The `WHERE dimensions = ?` clause enables the query planner to select the correct partial index.

------------------------------------------------------------------------

## Migration Plan

### Migration: `XXXXXXXXX_embedding_dimension_flexibility.cjs`

```sql
-- Step 1: Add dimensions column (populate from existing data)
ALTER TABLE kb_chunks ADD COLUMN dimensions integer;

-- Step 2: Backfill dimensions for existing rows
-- All existing embeddings are 1536 (the only dimension the old schema accepted)
UPDATE kb_chunks SET dimensions = 1536 WHERE embedding IS NOT NULL;
UPDATE kb_chunks SET dimensions = 0 WHERE embedding IS NULL;

-- Step 3: Make dimensions NOT NULL after backfill
ALTER TABLE kb_chunks ALTER COLUMN dimensions SET NOT NULL;

-- Step 4: Drop the old IVFFlat index
DROP INDEX IF EXISTS idx_kb_chunks_embedding;

-- Step 5: Change column type from vector(1536) to untyped vector
ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector;

-- Step 6: Create HNSW partial index for 1536 (existing data)
CREATE INDEX idx_kb_chunks_embedding_1536
  ON kb_chunks
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE dimensions = 1536;

-- Step 7: Create index on dimensions for query filtering
CREATE INDEX idx_kb_chunks_dimensions ON kb_chunks (artifact_id, dimensions);
```

### Rollback (down)

```sql
-- Delete any non-1536 chunks (they cannot be stored in the old schema)
DELETE FROM kb_chunks WHERE dimensions != 1536 AND dimensions != 0;

-- Drop new indexes
DROP INDEX IF EXISTS idx_kb_chunks_embedding_1536;
DROP INDEX IF EXISTS idx_kb_chunks_dimensions;

-- Restore typed column
ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(1536);

-- Recreate old IVFFlat index
CREATE INDEX idx_kb_chunks_embedding
  ON kb_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Drop dimensions column
ALTER TABLE kb_chunks DROP COLUMN dimensions;
```

**Caution:** The rollback deletes any non-1536 chunks because the old typed column cannot store them. This is destructive but acceptable for a draft migration (tenants can re-push).

------------------------------------------------------------------------

## Code Changes

### 1. `src/rag/retrieval.ts` (retrieval query)

Update the SQL query to include a `dimensions` filter and pass the query vector's dimension:

```typescript
const sql = `
  SELECT id, content, source_path,
         1 - (embedding <=> ?::vector) AS similarity_score
  FROM kb_chunks
  WHERE artifact_id = ?
    AND dimensions = ?
  ORDER BY embedding <=> ?::vector
  LIMIT ?
`;

// Pass dimensions as a parameter
const result = await knex.raw(sql, [
  vectorLiteral, artifactId, vector.length, vectorLiteral, topK
]);
```

### 2. `src/domain/entities/KbChunk.ts` (entity)

Add a `dimensions` property:

```typescript
dimensions!: number;
```

Update the constructor to compute dimensions from the embedding:

```typescript
this.dimensions = options?.embedding?.length ?? 0;
```

### 3. `src/domain/schemas/KbChunk.schema.ts` (entity schema)

Add the `dimensions` property mapping:

```typescript
dimensions: { type: 'integer', fieldName: 'dimensions' },
```

### 4. `src/services/EmbeddingAgentService.ts` (KNOWN_DIMENSIONS)

Expand the `KNOWN_DIMENSIONS` map to include common non-OpenAI models:

```typescript
const KNOWN_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'all-minilm': 384,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
};
```

Also update `cli/src/lib/embedding.ts` to match.

### 5. `src/routes/registry.ts` (push route: extract vectorSpace from manifest)

The push route currently extracts chunks from the `.orb` bundle manifest but does not extract `vectorSpace` metadata. Add extraction of vectorSpace and pass it through to `registryService.push()`:

```typescript
// Inside the KnowledgeBase extraction block, after parsing manifest:
let vectorSpaceData: PushInput['vectorSpaceData'] | undefined;
if (manifest.vectorSpace) {
  vectorSpaceData = {
    provider: manifest.vectorSpace.provider,
    model: manifest.vectorSpace.model,
    dimensions: manifest.vectorSpace.dimensions,
    preprocessingHash: manifest.vectorSpace.preprocessingHash,
  };
}
```

This is an existing bug (the CLI weave command writes `vectorSpace` into the manifest but the registry push route ignores it).

### 6. `src/services/RegistryService.ts` (chunk insertion)

When creating `KbChunk` instances, the `dimensions` property is computed automatically from `embedding.length` by the `KbChunk` constructor. No explicit change needed for dimension population.

------------------------------------------------------------------------

## Index Management

### Auto-creation of new dimension indexes

When a KB push introduces a dimension that has no existing partial HNSW index, the system must create one. This should happen as a post-push step in `RegistryService.push()`:

```typescript
// After all chunks are persisted and flushed:
if (input.vectorSpaceData) {
  const dim = input.vectorSpaceData.dimensions;
  await this._ensureDimensionIndex(dim, em);
}
```

The `_ensureDimensionIndex` helper checks `pg_indexes` for the expected index name and creates it if missing:

```sql
-- Check existence
SELECT 1 FROM pg_indexes
WHERE indexname = 'idx_kb_chunks_embedding_768';

-- Create if not found
CREATE INDEX CONCURRENTLY idx_kb_chunks_embedding_768
  ON kb_chunks
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WHERE dimensions = 768;
```

`CREATE INDEX CONCURRENTLY` is used to avoid locking the table during index creation.

**Important:** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. The index creation must happen outside the MikroORM flush transaction, either as a separate Knex `raw()` call after the transaction commits, or via a post-commit hook.

### Known dimension registry

Maintain a runtime cache of known indexed dimensions to avoid querying `pg_indexes` on every push. The cache is populated at startup by scanning `pg_indexes` and invalidated when a new index is created.

------------------------------------------------------------------------

## Multi-KB Interaction

When an agent references multiple knowledge bases (per the Multi-KB spec, `docs/system_specs/multi_kb_spec.md`), the referenced KBs may use different embedding models with different dimensionalities. The retrieval flow must account for this:

### Retrieval Strategy

1. Resolve all KB artifacts for the agent.
2. Group artifacts by their `vector_spaces.dimensions` value (available via the artifact's `vector_space_id` FK).
3. For each dimension group:
   a. Generate the query embedding using the appropriate embedding model for that group.
   b. Execute the dimension-filtered similarity search against all artifact IDs in the group.
4. Merge results from all dimension groups by similarity score.
5. Apply the global top-K limit.

### Example

An agent references three KBs:
- `product-docs-kb` (OpenAI `text-embedding-3-small`, 1536 dims)
- `api-reference-kb` (OpenAI `text-embedding-3-small`, 1536 dims)
- `internal-wiki-kb` (Ollama `nomic-embed-text`, 768 dims)

Retrieval produces two groups:
- Group 1 (1536): query embedding via OpenAI, search `product-docs-kb` and `api-reference-kb` chunks
- Group 2 (768): query embedding via Ollama nomic, search `internal-wiki-kb` chunks

This avoids the error of searching 768-dim chunks with a 1536-dim query vector.

### Embedding reuse optimization

Within a dimension group, if multiple KBs share the same embedding model, only one embedding call is needed for the query. The grouping key should be `(provider, model, dimensions)` rather than dimensions alone, to handle the edge case where two models produce the same dimensionality but incompatible vector spaces.

------------------------------------------------------------------------

## Testing Plan

### Unit Tests

1. **KbChunk entity:** Verify that constructing a `KbChunk` with a 768-dim embedding sets `dimensions = 768`.
2. **KbChunk entity:** Verify that constructing a `KbChunk` with no embedding sets `dimensions = 0`.
3. **KNOWN_DIMENSIONS:** Verify `dimensionsForModel('nomic-embed-text')` returns 768 (not fallback 1536).
4. **Retrieval query:** Mock Knex and verify the SQL includes `AND dimensions = ?` with the correct parameter.

### Integration Tests (SQLite)

5. **Push with 768-dim embeddings:** Create a KbChunk with a 768-element embedding array and verify it persists and can be read back. (Note: SQLite does not support pgvector, so this tests ORM mapping only.)

### Integration Tests (PostgreSQL)

6. **Migration forward:** Run the migration on a test database with existing 1536-dim data. Verify all existing rows have `dimensions = 1536`, the `embedding` column accepts 768-dim vectors, and the 1536 partial HNSW index exists.
7. **Migration rollback:** Run the down migration and verify the schema is restored. Verify non-1536 rows are deleted.
8. **Mixed-dimension push:** Push two KBs (one 1536-dim, one 768-dim) and verify both are stored successfully.
9. **Retrieval isolation:** Insert chunks with 1536-dim and 768-dim embeddings. Execute a 768-dim query and verify only 768-dim chunks are returned.
10. **Index auto-creation:** Push a KB with a new dimension (e.g., 384) and verify the partial HNSW index is created.

### CLI Tests

11. **Weave with nomic-embed-text:** Verify the `.orb` manifest contains `vectorSpace.dimensions: 768`.

### Smoke Tests

12. **End-to-end:** Push a KB embedded with nomic-embed-text via the CLI, deploy an agent referencing it, send a query, and verify RAG context is injected successfully.

------------------------------------------------------------------------

## Open Questions

1. **IVFFlat vs HNSW for large KBs:** HNSW is chosen for its simplicity (no training step), but for KBs with 100k+ chunks, IVFFlat may offer better insert performance. Should we support per-KB index type selection?

2. **`CREATE INDEX CONCURRENTLY` and transactions:** MikroORM wraps flushes in transactions by default. The implementation must ensure index creation happens outside the transaction boundary.

3. **Dimension limit:** Should there be a maximum allowed dimension? pgvector supports up to 16,000 dimensions for HNSW indexes.

4. **Denormalization consistency:** The `kb_chunks.dimensions` column is a denormalization of `vector_spaces.dimensions`. Should retrieval join through `artifacts.vector_space_id` instead? The denormalized column is simpler for query performance but introduces a consistency risk.

5. **Registry push route gap:** The registry push route (`src/routes/registry.ts`) currently does not extract `vectorSpace` from the `.orb` manifest, even though the CLI weave command writes it. Should this fix be bundled with the dimension flexibility migration or addressed as a separate bugfix?

6. **Re-embedding existing KBs:** If a tenant wants to switch embedding models, the entire KB must be re-embedded and re-pushed. Should the system detect model changes and warn the user?
