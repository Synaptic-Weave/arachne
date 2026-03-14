# RAG Inference

Retrieval-Augmented Generation (RAG) allows Arachne agents to augment their responses with relevant knowledge from a deployed knowledge base. At request time, user queries are embedded, the knowledge base is semantically searched, and the top-K chunks are injected into the system prompt.

## Overview

When a request flows through the gateway for an agent with a `knowledgeBaseRef`:

1. **Embedder resolution** — Determine which embedding provider/model to use
2. **Query embedding** — Call the embedder API to vectorize the user's query
3. **pgvector similarity search** — Find top-K chunks by cosine similarity
4. **Context injection** — Prepend retrieved chunks to the system prompt
5. **Fallback handling** — If any stage fails, gracefully degrade (serve request without RAG)
6. **Trace recording** — Capture 13 RAG-specific trace fields for observability

The entire process is non-blocking and isolated from the main LLM request; RAG failures do not break the request.

## Embedder Resolution

Before querying the knowledge base, the system must resolve which embedding provider and model to use. The resolution order is:

1. **Named embedding agent** (if `agent.embeddingAgentRef` is set) — Look up the agent by name in the tenant's agents table, parse its config (stored as JSON in the systemPrompt field)
2. **System embedder env vars** — Fall back to `SYSTEM_EMBEDDER_PROVIDER` and `SYSTEM_EMBEDDER_MODEL` environment variables
3. **Settings default embedder provider** — If `Settings.defaultEmbedderProviderId` is set, load the corresponding gateway provider entity and derive the embedder config (provider type, base URL, API key, model, dimensions) from the provider's stored fields
4. **Settings legacy fields** — Fall back to `Settings.embedderProvider`, `Settings.embedderModel`, etc. if they exist as standalone fields
5. **Error** — If none of the above are configured, return a clear error

**System Embedder Environment Variables:**

```bash
SYSTEM_EMBEDDER_PROVIDER=openai
SYSTEM_EMBEDDER_MODEL=text-embedding-3-small
SYSTEM_EMBEDDER_DIMENSIONS=1536
SYSTEM_EMBEDDER_API_KEY=sk-...
```

If a named embedding agent is referenced but not found, retrieval fails gracefully and the request proceeds without RAG context.

## Query Embedding

Once the embedder is resolved, the user's query (the last user message in the request) is vectorized:

```
POST https://api.openai.com/v1/embeddings
{
  "model": "text-embedding-3-small",
  "input": "user query text"
}
```

**Azure embedding routing:**

```
POST {baseUrl}/openai/deployments/{deployment}/embeddings?api-version={apiVersion}
Headers: api-key: {apiKey}
Body: { "input": "user query text" }
```

Azure uses `api-key` header authentication instead of Bearer tokens, and routes through deployment-specific URLs rather than a global `/v1/embeddings` endpoint.

**Ollama embedding routing:**

```
POST {baseUrl}/api/embeddings
Body: { "model": "nomic-embed-text", "prompt": "user query text" }
```

Ollama's response shape differs from the OpenAI format. It returns `{ embedding: [...] }` directly rather than `{ data: [{ embedding: [...] }] }`. The embedding adapter normalizes this before passing the vector to the search stage.

**Result:** A `number[]` vector of fixed dimensions (e.g., 1536 for OpenAI's small model).

**Latency:** Captured as `embeddingLatencyMs` in traces.

## pgvector Similarity Search

The query vector is used to search the knowledge base's chunks via PostgreSQL's pgvector extension (cosine similarity):

```sql
SELECT id, content, source_path,
       1 - (embedding <=> ?::vector) AS similarity_score
FROM kb_chunks
WHERE artifact_id = ?
ORDER BY embedding <=> ?::vector
LIMIT ?
```

**pgvector Operator:** The `<=>` operator computes cosine distance; `1 - distance` yields a similarity score from 0 to 1.

**Result:** Top-K chunks ranked by similarity, with:
- `id` — Chunk UUID
- `content` — The text chunk
- `source_path` — Original file path within the knowledge base
- `similarity_score` — 0.0 to 1.0 (1.0 = exact match)
- `rank` — 1-based rank in results (1 = most similar)

**Latency:** Captured as `vectorSearchLatencyMs` in traces.

## Citation Block Format

Retrieved chunks are formatted as a citation block and injected at the start of the system prompt:

```
--- Knowledge Base Context ---
[1] {chunk_content} (source: {source_path})
[2] {chunk_content}
[3] {chunk_content}
...
---
Answer based on the above context. Cite sources as [1], [2], etc.
```

**Example:**

```
--- Knowledge Base Context ---
[1] The Arachne gateway is a multi-tenant proxy for LLM providers, routing requests to OpenAI, Azure, or other compatible endpoints. (source: docs/architecture.md)
[2] Agents can define custom system prompts, skills (MCP tools), and merge policies to control how context is injected. (source: docs/agents.md)
---
Answer based on the above context. Cite sources as [1], [2], etc.

[original system prompt from agent or user request]
```

If no chunks are retrieved, the citation block is omitted entirely.

## Graceful Degradation

RAG is never blocking. If any stage fails (embedder resolution, embedding API, search, or injection), the request continues **without RAG context**:

- **Embedder not found:** Log warning, fallback to no RAG
- **Embedding API error:** Log error, fallback to no RAG
- **Search error:** Log error, fallback to no RAG
- **Context injection error:** Log error, fallback to no RAG

The `fallbackToNoRag: true` flag in the trace indicates the request proceeded without RAG due to a failure.

## RAG Trace Fields

Every request that touches RAG (whether successfully or not) records these 13 fields in the trace:

| Field | Type | Description |
|-------|------|-------------|
| `knowledgeBaseId` | string | UUID of the KB artifact |
| `ragRetrievalLatencyMs` | number | Total time for embedding + search (start to finish) |
| `embeddingLatencyMs` | number | Time to call embedding API |
| `vectorSearchLatencyMs` | number | Time for pgvector similarity search |
| `retrievedChunkCount` | number | Number of chunks returned (0-K) |
| `topChunkSimilarity` | number | Similarity score of the highest-ranked chunk (0.0-1.0) |
| `avgChunkSimilarity` | number | Average similarity of all retrieved chunks |
| `ragStageFailed` | string | Which stage failed: `'retrieval'`, `'embedding'`, `'injection'`, or `'none'` (success) |
| `fallbackToNoRag` | boolean | Whether the request proceeded without RAG due to failure |
| (implicit) `queryText` | string | Not stored; the actual user query is encrypted with the trace |
| (implicit) `retrievalTopK` | number | Not stored; always 5 in current implementation |

**Example trace:**

```json
{
  "knowledgeBaseId": "550e8400-e29b-41d4-a716-446655440000",
  "ragRetrievalLatencyMs": 342,
  "embeddingLatencyMs": 250,
  "vectorSearchLatencyMs": 92,
  "retrievedChunkCount": 5,
  "topChunkSimilarity": 0.87,
  "avgChunkSimilarity": 0.79,
  "ragStageFailed": "none",
  "fallbackToNoRag": false
}
```

## RAG Sources in Response Body

The `rag_sources` array is included directly in the `/v1/chat/completions` response body (in addition to trace metadata), making citation data available to API consumers without requiring trace access:

```json
{
  "id": "chatcmpl-abc123",
  "choices": [...],
  "rag_sources": [
    {
      "rank": 1,
      "sourcePath": "docs/architecture.md",
      "similarityScore": 0.87,
      "contentPreview": "The Arachne gateway is a multi-tenant proxy..."
    },
    {
      "rank": 2,
      "sourcePath": "docs/agents.md",
      "similarityScore": 0.82,
      "contentPreview": "Agents can define custom system prompts..."
    }
  ]
}
```

Each entry contains:
- `rank` — 1-based position in similarity-ranked results
- `sourcePath` — Original file path within the knowledge base
- `similarityScore` — Cosine similarity (0.0 to 1.0)
- `contentPreview` — Truncated text preview of the retrieved chunk

If RAG is not active or no chunks are retrieved, the `rag_sources` field is omitted from the response.

## Knowledge Base Insights API

The portal exposes several endpoints for inspecting knowledge base contents and testing retrieval:

**Chunks endpoint** — List all chunks in a knowledge base with pagination:

```
GET /v1/portal/knowledge-bases/:id/chunks?page=1&limit=20
```

Returns chunk content, source path, and chunk index for browsing the full KB.

**Sources endpoint** — List unique source files in a knowledge base:

```
GET /v1/portal/knowledge-bases/:id/sources
```

Returns a deduplicated list of source paths with chunk counts per file.

**Search preview endpoint** — Test retrieval against a knowledge base without making a full chat completion:

```
POST /v1/portal/knowledge-bases/:id/search
Body: { "query": "search text", "topK": 5 }
```

Returns the same ranked results as the RAG pipeline (rank, sourcePath, similarityScore, content) for previewing what an agent would retrieve for a given query.

## Configuration & Deployment

### In the Portal

1. Create a knowledge base via the CLI and deploy it
2. Edit an agent and select the deployed knowledge base from the dropdown
3. Specify `knowledgeBaseRef` pointing to the KB name
4. Save and test in the chat interface

The agent's next request will automatically retrieve and inject RAG context.

### In the CLI

Define an agent YAML with a `knowledgeBaseRef`:

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: my-agent
spec:
  model: gpt-4o
  systemPrompt: |
    You are a helpful assistant. Use the knowledge base to answer questions.
  knowledgeBaseRef: my-kb
```

Weave and push the agent to the registry, then deploy it.

## Performance & Limits

- **Concurrent embeddings:** Batched at 100 texts per API call
- **Chunk retrieval:** Top-K = 5 (hard-coded; configurable in future)
- **Embedding dimensions:** Inferred from the embedder model (1536 for text-embedding-3-small)
- **Knowledge base size:** Limited only by PostgreSQL storage and pgvector performance

For typical deployments (100K-1M chunks), pgvector searches complete in <100ms.

## Debugging

Check the trace records to diagnose RAG issues:

- **`ragStageFailed === 'none'` & `retrievedChunkCount > 0`** — RAG working correctly
- **`ragStageFailed === 'embedding'`** — Check SYSTEM_EMBEDDER_API_KEY and provider settings
- **`ragStageFailed === 'retrieval'`** — Check KB deployment and database connectivity
- **`topChunkSimilarity < 0.5`** — Retrieved chunks are weakly relevant; KB may not cover the query topic

## Future Work

- Named embedding agents per knowledge base (higher priority than tenant default)
- Configurable top-K per agent (not fixed at 5)
- Hybrid search (keyword + semantic)
- Chunk deduplication and compression
- Re-ranking and multi-query expansion
