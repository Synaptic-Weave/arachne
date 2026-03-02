# System Embedder Configuration

The **system embedder** is a tenant-wide default embedding provider used for knowledge base vectorization and query embedding during RAG retrieval. It eliminates the need to specify an embedder for every agent and knowledge base.

## Overview

When weaving a knowledge base or executing RAG inference, Arachne needs to convert text into vectors for semantic search. The system embedder provides a single, centralized source of truth for that embedding model and API credentials.

**Use cases:**
- **Default KB embeddings** — All knowledge bases use the same embedder unless explicitly overridden
- **RAG query embedding** — Queries are embedded with the system embedder at inference time
- **Consistent vector space** — All chunks and queries use the same dimensions and model for meaningful similarity scores

## Configuration

System embedder is configured via four environment variables:

### `SYSTEM_EMBEDDER_PROVIDER`

The embedding service provider.

**Supported values:**
- `openai` — OpenAI's embedding API (default)

**Example:**
```bash
export SYSTEM_EMBEDDER_PROVIDER=openai
```

### `SYSTEM_EMBEDDER_MODEL`

The specific embedding model to use.

**Common models:**
- `text-embedding-3-small` — Fast, 1536 dimensions, good for most use cases
- `text-embedding-3-large` — Higher quality, 3072 dimensions, slower
- `text-embedding-ada-002` — Legacy OpenAI model, 1536 dimensions

**Example:**
```bash
export SYSTEM_EMBEDDER_MODEL=text-embedding-3-small
```

### `SYSTEM_EMBEDDER_DIMENSIONS`

Vector dimensions output by the model (optional; inferred if omitted).

**Example:**
```bash
export SYSTEM_EMBEDDER_DIMENSIONS=1536
```

### `SYSTEM_EMBEDDER_API_KEY`

API key for the embedding provider (required).

**For OpenAI:**
```bash
export SYSTEM_EMBEDDER_API_KEY=sk-proj-...
```

Generate an API key at [platform.openai.com](https://platform.openai.com/account/api-keys).

⚠️ **Security:** Store the key securely (e.g., via `.env` file, secrets manager, or environment variable). Never commit to source control.

## Setup Checklist

1. **Create an API key** in your provider's dashboard
2. **Set all four env vars** (at least PROVIDER, MODEL, and API_KEY are required)
3. **Restart the Arachne gateway** for changes to take effect
4. **Test embeddings** by creating a knowledge base or calling the RAG endpoint

**Example `.env`:**
```bash
SYSTEM_EMBEDDER_PROVIDER=openai
SYSTEM_EMBEDDER_MODEL=text-embedding-3-small
SYSTEM_EMBEDDER_DIMENSIONS=1536
SYSTEM_EMBEDDER_API_KEY=sk-proj-your-key-here
```

**Restart Arachne:**
```bash
# If running with docker-compose
docker-compose down && docker-compose up -d

# If running locally
npm run dev
```

## System Embedder vs. Tenant-Level / Agent-Level Embedders

Arachne supports three levels of embedder configuration:

### System Embedder (Fallback)

**Scope:** Global (all tenants, all agents)  
**Configuration:** Environment variables  
**Use:** Default when no tenant or agent embedder is specified  
**Priority:** Lowest

Set once at server startup. All tenants use it unless overridden.

### Tenant Embedder (Future)

**Scope:** Single tenant (all agents in that tenant)  
**Configuration:** Via portal settings (not yet implemented)  
**Use:** Override system embedder for a specific tenant  
**Priority:** Medium

When implemented, tenants can specify their own preferred embedder (e.g., a private or custom model).

### Named Embedding Agent (Future)

**Scope:** Single knowledge base or agent  
**Configuration:** Define an `EmbeddingAgent` artifact and reference it by name  
**Use:** Fine-grained control per KB or agent  
**Priority:** Highest

When implemented, agents can specify `embeddingAgentRef: my-embedder` to use a custom embedder.

**Current resolution order:**
1. Named embedding agent (not yet functional in P0)
2. System embedder (what gets used now)
3. Error if neither configured

## Knowledge Base Weaving

When you weave a knowledge base using the CLI, it uses the system embedder to vectorize all chunks:

```bash
arachne weave my-kb.yaml
```

**What happens:**
1. Reads the YAML spec
2. Resolves docs (directory, .zip file, or single file)
3. Chunks text based on `spec.chunking.tokenSize` and overlap
4. Calls OpenAI embedding API (in batches of 100) using `SYSTEM_EMBEDDER_MODEL`
5. Packages chunks + embeddings into a `.tgz` bundle
6. Signs with HMAC-SHA256

The bundle records the embedder provider, model, and dimensions in `manifest.json`. This information is used at inference time to verify compatibility.

## RAG Query Embedding

At request time, if an agent has a `knowledgeBaseRef`:

1. **Resolve embedder** — Check if the KB specifies a named embedder (not yet); fall back to system embedder
2. **Embed query** — Call the embedding API with the user's last message
3. **Search KB** — Use pgvector to find top-K similar chunks
4. **Inject context** — Prepend retrieved chunks to the system prompt

All embeddings in the system (chunks + queries) must use the **same model and dimensions** for meaningful similarity scores.

**If the embedding API fails:**
- Request continues without RAG context
- An error is logged and recorded in the trace
- Subsequent requests retry normally

## Changing Embedder Configuration

If you change the `SYSTEM_EMBEDDER_*` environment variables:

1. **Existing knowledge bases remain unchanged** — They retain their original embedder configuration (recorded in the bundle)
2. **New knowledge bases** use the updated embedder
3. **RAG queries** use the updated embedder to vectorize queries

If you switch from one embedding model to another, **existing and new KBs will have incompatible vector spaces**. To migrate:

```bash
# 1. Weave all KBs again with the new embedder
SYSTEM_EMBEDDER_MODEL=text-embedding-3-large arachne weave my-kb.yaml

# 2. Push with a new tag
arachne push my-kb.tgz --name my-kb --tag v2-large

# 3. Deploy the new version
arachne deploy my-org/my-kb:v2-large

# 4. Update agents to use the new KB
# (in portal or via agent spec)
```

## Performance Considerations

**Batching:** The Arachne gateway batches embedding requests at 100 texts per API call, reducing latency and cost.

**Caching:** Query embeddings are not cached (computed fresh per request). KB chunk embeddings are pre-computed during weaving.

**Concurrency:** Multiple knowledge base weave operations can run in parallel; embedding API calls are rate-limited by your OpenAI account quota.

**Cost estimation:**
- OpenAI's text-embedding-3-small: ~$0.02 per 1M tokens
- A 650-token chunk → ~0.65 embeddings at scale
- 1000-chunk KB → ~$0.00013 to weave

## Troubleshooting

### Knowledge base weave fails with "Embedding provider not configured"

**Solution:** Ensure all three required env vars are set:
```bash
export SYSTEM_EMBEDDER_PROVIDER=openai
export SYSTEM_EMBEDDER_MODEL=text-embedding-3-small
export SYSTEM_EMBEDDER_API_KEY=sk-...
```

### Embedding API returns 401 Unauthorized

**Solution:** Check your OpenAI API key:
1. Log into [platform.openai.com](https://platform.openai.com)
2. Generate a new API key if the old one expired
3. Update `SYSTEM_EMBEDDER_API_KEY` and restart Arachne

### Embedding API returns 429 Rate Limited

**Solution:** OpenAI has rate limits. Wait a few minutes or upgrade your account tier.

### RAG queries fail but knowledge base was weaved successfully

**Possible causes:**
- Embedding API quota exhausted
- KB was weaved with a different embedder model (vector space mismatch)
- pgvector extension not installed on PostgreSQL

### Retrieved chunks are not relevant (low similarity scores)

**Possible causes:**
- Knowledge base doesn't cover the query topic
- Embedding model is not well-suited for your domain (consider upgrading to `text-embedding-3-large`)
- Chunks are too small or too large (adjust `tokenSize` in the KB spec)

## Advanced: Custom Embedders (Future)

In a future release, you can define custom embedding agents:

```yaml
apiVersion: arachne-ai.com/v0
kind: EmbeddingAgent
metadata:
  name: my-embedder
spec:
  provider: openai
  model: text-embedding-3-large
  # Future: could reference a private service or LLaMA-based model
```

Then reference it in KnowledgeBases or Agents:

```yaml
apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: my-kb
spec:
  docsPath: ./docs
  embedder:
    agentRef: my-embedder  # Use custom embedder instead of system default
```

This enables multi-tenant embedder isolation, custom models, and fine-grained control.
