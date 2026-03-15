---
title: RAG Inference
description: How retrieval-augmented generation works in Arachne
order: 3
---


Arachne has built-in support for retrieval-augmented generation (RAG). Attach a knowledge base to any agent, and Arachne will automatically retrieve relevant context and inject it into every request — no external vector database or orchestration layer required.

## How It Works

When a request arrives for an agent with an attached knowledge base, the gateway executes the following pipeline:

1. **Extract the query** from the last user message.
2. **Generate an embedding** using the configured embedder.
3. **Search for similar chunks** in PostgreSQL using pgvector cosine similarity.
4. **Inject the top-k results** into the system prompt as context.
5. **Forward the enriched request** to the LLM provider.
6. **Return RAG metadata** (`rag_sources`) in the response for transparency.

## Embedder Resolution Chain

Arachne resolves the embedding provider using a fallback chain:

1. **Tenant-level setting** — If the tenant has configured a specific embedder in their settings, it takes priority.
2. **System-level environment variables** — `SYSTEM_EMBEDDER_PROVIDER`, `SYSTEM_EMBEDDER_MODEL`, and `SYSTEM_EMBEDDER_API_KEY`.
3. **Agent's own provider** — Falls back to the agent's configured LLM provider if it supports embeddings.

Supported embedder providers:

| Provider | Models | Configuration |
|----------|--------|---------------|
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002` | API key |
| Azure OpenAI | Any deployed embedding model | Endpoint + API key + deployment |
| Ollama | `nomic-embed-text`, `mxbai-embed-large`, etc. | Base URL (no key required) |

## Knowledge Base Creation

### Ingestion Pipeline

When you create a knowledge base and upload documents:

1. **Chunking** — Documents are split into segments with configurable size and overlap.
2. **Embedding** — Each chunk is sent to the embedder to produce a vector representation.
3. **Storage** — Chunks and their embeddings are stored in the `knowledge_base_chunks` table with a pgvector `vector` column.

### Supported Formats

- Plain text (`.txt`)
- Markdown (`.md`)
- PDF (`.pdf`)

### Via the Portal

Navigate to **Knowledge Bases > Create**, upload your files, and Arachne handles the rest. You can monitor ingestion progress and browse individual chunks.

### Via the CLI

Bundle documents alongside your agent spec:

```yaml
kind: Agent
name: docs-assistant

knowledge_base:
  ref: product-docs
  sources:
    - docs/guide.md
    - docs/faq.md
  top_k: 5
```

Running `arachne weave` will package the documents, and `arachne deploy` will ingest and embed them on the target instance.

## Vector Search

At query time, Arachne performs a cosine similarity search:

```sql
SELECT id, content, 1 - (embedding <=> $1) AS similarity
FROM knowledge_base_chunks
WHERE knowledge_base_id = $2
ORDER BY embedding <=> $1
LIMIT $3
```

- `$1` is the query embedding vector.
- `$2` is the knowledge base ID.
- `$3` is the `top_k` parameter (default: 5).

Results are filtered by a minimum similarity threshold to avoid injecting irrelevant context.

## RAG Context Injection

Retrieved chunks are formatted and prepended to the system prompt:

```
Use the following context to answer the user's question.
If the context doesn't contain relevant information, say so.

---
[Context 1] (similarity: 0.94)
Arachne is a multi-tenant AI gateway that proxies requests to any LLM provider...

[Context 2] (similarity: 0.89)
The gateway supports OpenAI, Azure OpenAI, and Ollama as upstream providers...
---
```

The agent's original system prompt follows the injected context, so the LLM has both the retrieved knowledge and the agent's behavioral instructions.

## RAG Sources in the Response

When RAG is active, the gateway response includes a `rag_sources` field:

```json
{
  "choices": [...],
  "rag_sources": [
    {
      "chunk_id": "chunk_001",
      "content": "Arachne is a multi-tenant AI gateway...",
      "similarity": 0.94,
      "knowledge_base": "product-docs"
    },
    {
      "chunk_id": "chunk_002",
      "content": "The gateway supports OpenAI, Azure...",
      "similarity": 0.89,
      "knowledge_base": "product-docs"
    }
  ]
}
```

Use `rag_sources` to build citation UIs, debug retrieval quality, or log which documents influenced each response.

## Trace Metrics

RAG performance is recorded in every trace:

- **Embedding latency** — Time to generate the query embedding.
- **Search latency** — Time to execute the vector search.
- **Chunk count** — Number of chunks retrieved.
- **Similarity scores** — Min, max, and average similarity of retrieved chunks.

View these metrics in the dashboard to monitor retrieval quality and optimize your knowledge base.
