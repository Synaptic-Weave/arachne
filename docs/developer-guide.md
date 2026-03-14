# Arachne Developer Guide

## Architecture Overview

This guide covers source layout, API extensions, database schema, and the technical stack. For component design, data flows, and encryption patterns, see **[Architecture](architecture.md)**.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Server startup, route registration |
| `src/agent.ts` | System prompt/skills injection, MCP round-trip handling |
| `src/conversations.ts` | Conversation lifecycle, message storage, snapshot creation |
| `src/tracing.ts` | Trace recording with batching and async flushing |
| `src/analytics.ts` | Time-series metrics and aggregation queries |
| `src/providers/` | Provider implementations (OpenAI, Azure, Ollama, Registry) |
| `src/routes/` | API routes (admin, portal, dashboard) |
| `src/domain/` | MikroORM entities and repositories |
| `src/application/services/` | Application services (Portal, Admin, Dashboard) |

## Portal API

### POST /v1/portal/knowledge-bases (multipart)

Create a knowledge base by uploading files directly. Requires owner role.

**Multipart fields:**
- `name` (string, required) — Knowledge base name
- `files` (file, required, multiple) — Document files (.txt, .md, .json, .csv, .pdf)

**Processing:** The server chunks uploaded text (650 tokens, 120 overlap), generates embeddings via the configured system embedder, and pushes the result to the registry. PDF files are processed server-side using `pdf-parse` for text extraction.

**Response:**
```json
{
  "id": "artifact-uuid",
  "name": "my-kb",
  "org": "my-org",
  "ref": "my-org/my-kb:latest",
  "chunkCount": 42
}
```

### PATCH /v1/portal/settings

Accepts `name` (string) and `orgSlug` (string) fields in addition to provider config. Both are validated server-side. The slug must be unique across all tenants.

### GET /v1/portal/embedder-info

Check whether an embedding model is configured for the tenant.

**Response:**
```json
{
  "available": true,
  "provider": "openai",
  "model": "text-embedding-3-small"
}
```

### GET /v1/portal/available-providers

List gateway providers available to the tenant. Includes providers marked `tenantAvailable=true` as well as those with per-tenant access grants.

**Response:**
```json
{
  "providers": [
    {
      "id": "provider-uuid",
      "name": "OpenAI Production",
      "type": "openai",
      "availableModels": ["gpt-4o", "gpt-4o-mini"],
      "baseUrl": "https://api.openai.com"
    }
  ]
}
```

### GET /v1/portal/knowledge-bases/:id/chunks

Paginated listing of chunks in a knowledge base.

**Query parameters:**
- `limit` (integer, optional, default 50) — Page size
- `offset` (integer, optional, default 0) — Offset for pagination

**Response:**
```json
{
  "chunks": [
    {
      "id": "chunk-uuid",
      "index": 0,
      "content": "chunk text...",
      "sourcePath": "readme.md",
      "tokenCount": 312,
      "metadata": {},
      "createdAt": "2026-03-14T00:00:00.000Z"
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

### GET /v1/portal/knowledge-bases/:id/sources

Source file inventory for a knowledge base.

**Response:**
```json
{
  "sources": [
    {
      "sourcePath": "readme.md",
      "chunkCount": 12,
      "totalTokens": 4200
    }
  ]
}
```

### POST /v1/portal/knowledge-bases/:id/search

Semantic search preview against a knowledge base. Generates an embedding for the query and runs a vector similarity search.

**Request body:**
```json
{
  "query": "How does authentication work?",
  "topK": 5
}
```

**Response:**
```json
{
  "query": "How does authentication work?",
  "chunks": [
    {
      "rank": 1,
      "content": "chunk text...",
      "sourcePath": "auth.md",
      "similarityScore": 0.92
    }
  ],
  "embeddingLatencyMs": 45,
  "vectorSearchLatencyMs": 12,
  "totalLatencyMs": 57
}
```

### POST /v1/portal/agents/:id/chat

Sandbox chat with an agent. Routes through the gateway for full production parity — RAG injection, conversation memory, merge policies, and tracing all apply. Uses an internal sandbox API key.

When the agent has a knowledge base attached, the response includes a `rag_sources` array with retrieval metadata.

**Request body:** Standard OpenAI chat completion request format.

**Response:** Standard OpenAI chat completion response, extended with `rag_sources` when RAG retrieval is used.

## Admin API

### PUT /v1/admin/providers/:id/availability

Toggle whether a gateway provider is available to all tenants by default.

**Request body:**
```json
{
  "tenantAvailable": true
}
```

### GET /v1/admin/providers/:id/tenants

List tenants with specific access grants to a provider. Returns tenants that have been individually granted access regardless of the provider's global `tenantAvailable` flag.

### POST /v1/admin/providers/:id/tenants

Grant a specific tenant access to a provider.

**Request body:**
```json
{
  "tenantId": "tenant-uuid"
}
```

### DELETE /v1/admin/providers/:id/tenants/:tenantId

Revoke a specific tenant's access to a provider.

## API Extensions

Arachne proxies OpenAI's `/v1/chat/completions` endpoint with the following extensions:

### Request Extensions

- `conversation_id` (optional) — External conversation identifier for memory injection
- `partition_id` (optional) — External partition identifier for hierarchical conversation storage

### Response Extensions

- `conversation_id` — Echo of request conversation ID
- `partition_id` — Echo of request partition ID (if provided)
- `rag_sources` — Array of retrieval sources when RAG is used: `[{ rank, sourcePath, similarityScore, contentPreview }]`
- `X-Arachne-Conversation-ID` header — Resolved conversation UUID

## Stack

**Runtime & Framework:**
- Node.js + TypeScript
- Fastify (HTTP server)
- undici (HTTP client)

**Data Persistence:**
- PostgreSQL 16
- MikroORM (ORM)
- Knex (raw SQL queries)

**Security & Encryption:**
- AES-256-GCM (data at rest)
- JWT (authentication)
- Scrypt (password hashing)
- SHA-256 (API key hashing)

**Frontend:**
- Vite + React (Portal and Dashboard SPAs)

## Database Schema

### Core Tables

**tenants**
- `id` (uuid) — Primary key
- `name` (varchar) — Display name
- `status` (varchar) — 'active' or 'inactive'
- `parent_id` (uuid) — Optional parent tenant (for subtenant hierarchy)
- `provider_config` (jsonb) — Provider-specific credentials and settings
- `system_prompt`, `skills`, `mcp_endpoints` (text/jsonb) — Inheritable agent defaults
- `default_embedder_provider_id` (uuid) — Optional reference to a gateway provider used as the default embedding model
- `created_at`, `updated_at` (timestamptz)

**api_keys**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `agent_id` (uuid) — Foreign key to agents (each key bound to one agent)
- `name` (varchar) — Display name
- `key_prefix` (varchar) — First 12 chars of key (for UI display)
- `key_hash` (varchar) — SHA-256 hash of full key (for lookup)
- `status` (varchar) — 'active' or 'revoked'
- `created_at`, `revoked_at` (timestamptz)

**agents**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `name` (varchar) — Agent display name
- `system_prompt` (text) — Custom system instructions
- `skills` (jsonb) — Tool/function definitions (OpenAI format)
- `mcp_endpoints` (jsonb) — MCP server URLs for tool execution
- `merge_policies` (jsonb) — How to merge agent context (system_prompt, skills, mcp_endpoints strategies)
- `provider_config` (jsonb) — Optional agent-specific provider override
- `conversations_enabled` (boolean) — Whether this agent uses conversation memory
- `conversation_token_limit` (integer) — Token budget before auto-summarization
- `conversation_summary_model` (varchar) — Which model to use for summarization
- `created_at`, `updated_at` (timestamptz)

**traces**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `agent_id` (uuid) — Foreign key to agents (nullable)
- `request_id` (uuid) — Request trace UUID
- `model` (varchar) — Model name (e.g., 'gpt-4o')
- `provider` (varchar) — Provider name (e.g., 'openai')
- `endpoint` (varchar) — API endpoint path
- `request_body` (jsonb) — Encrypted request (ciphertext in hex)
- `request_iv` (varchar) — Encryption IV
- `response_body` (jsonb) — Encrypted response (nullable, ciphertext in hex)
- `response_iv` (varchar) — Encryption IV (nullable)
- `latency_ms` (integer) — Round-trip latency
- `prompt_tokens`, `completion_tokens`, `total_tokens` (integer) — Token counts
- `status_code` (integer) — HTTP status
- `ttfb_ms` (integer) — Time to first byte
- `gateway_overhead_ms` (integer) — Pre/post-LLM overhead
- `encryption_key_version` (integer) — Key version for decryption
- `created_at` (timestamptz) — Partitioned by month

*Traces are automatically partitioned by month (`traces_YYYY_MM` child tables) for efficient querying and retention.*

**conversations**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `agent_id` (uuid) — Foreign key to agents (nullable)
- `partition_id` (uuid) — Foreign key to partitions (nullable)
- `external_id` (varchar) — External conversation identifier (from request)
- `created_at`, `last_active_at` (timestamptz)

**conversation_messages**
- `id` (uuid) — Primary key
- `conversation_id` (uuid) — Foreign key to conversations
- `role` (varchar) — 'user', 'assistant', 'system', etc.
- `content_encrypted` (text) — Encrypted message content
- `content_iv` (varchar) — Encryption IV
- `token_estimate` (integer) — Approximate token count
- `trace_id` (uuid) — Optional reference to trace
- `snapshot_id` (uuid) — Optional reference to snapshot (for archival tracking)
- `created_at` (timestamptz)

**conversation_snapshots**
- `id` (uuid) — Primary key
- `conversation_id` (uuid) — Foreign key to conversations
- `summary_encrypted` (text) — Encrypted LLM summary
- `summary_iv` (varchar) — Encryption IV
- `messages_archived` (integer) — Count of messages included in summary
- `created_at` (timestamptz)

**partitions**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `parent_id` (uuid) — Optional parent partition (for hierarchy)
- `external_id` (varchar) — External partition identifier
- `title_encrypted`, `title_iv` (text/varchar) — Optional encrypted partition title
- `created_at` (timestamptz)

**admin_users**
- `id` (uuid) — Primary key
- `username` (varchar) — Login username
- `password_hash` (varchar) — Scrypt hash (salt:derivedKey)
- `created_at`, `last_login` (timestamptz)

**tenant_memberships**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `user_id` (uuid) — Foreign key to users
- `role` (varchar) — 'admin', 'member', etc.
- `created_at` (timestamptz)

**users**
- `id` (uuid) — Primary key
- `email` (varchar) — Unique email address
- `password_hash` (varchar) — Scrypt hash
- `created_at` (timestamptz)

**invites**
- `id` (uuid) — Primary key
- `tenant_id` (uuid) — Foreign key to tenants
- `token` (varchar) — Unique invite token
- `max_uses`, `use_count` (integer) — Invite limits
- `expires_at`, `revoked_at` (timestamptz)
