---
title: Architecture
description: Arachne system architecture and design
order: 2
---


Arachne is a single-process runtime that combines an AI gateway, a tenant portal, and an operator dashboard into one deployable unit. This document covers the system design, request flow, and key architectural decisions.

## High-Level Components

```
                    +------------------+
                    |   Load Balancer  |
                    +--------+---------+
                             |
              +--------------+--------------+
              |        Arachne Runtime      |
              |                             |
              |  +--------+  +-----------+  |
              |  |Gateway |  |  Portal   |  |
              |  | API    |  |  API/UI   |  |
              |  +--------+  +-----------+  |
              |  +--------+  +-----------+  |
              |  | Admin  |  | Dashboard |  |
              |  | API    |  |   API/UI  |  |
              |  +--------+  +-----------+  |
              +--------------+--------------+
                      |              |
              +-------+------+  +---+----+
              | PostgreSQL   |  |  LLM   |
              | + pgvector   |  |Providers|
              +--------------+  +--------+
```

- **Gateway** — OpenAI-compatible proxy that routes requests to LLM providers with agent logic, conversation memory, and RAG injection.
- **Portal** — Self-service API and React UI for tenants to manage agents, knowledge bases, API keys, and team members.
- **Dashboard** — Operator-facing API and React UI for analytics, traces, and system monitoring.
- **Admin** — System administration API for managing tenants and global provider configurations.

## Request Flow

Every chat completion request passes through a well-defined pipeline:

1. **Authentication** — The API key is resolved from the `Authorization` or `x-api-key` header. An LRU cache (1,000 entries) minimizes database lookups. The key maps to a tenant, agent, and provider configuration.

2. **Conversation Memory** — If the agent has `conversations_enabled`, existing messages and snapshots are loaded for the conversation thread. When the token estimate exceeds the configured limit, history is summarized into a snapshot via an LLM call.

3. **RAG Injection** — If the agent references a knowledge base, the user's query is embedded and used for a vector similarity search against stored chunks. The top-k results are injected into the system prompt.

4. **Agent Application** — The agent's system prompt, skills, and merge policies are applied to the request. Skills can be appended, prepended, or replace segments of the system prompt.

5. **Provider Routing** — The provider adapter (OpenAI, Azure, or Ollama) is selected based on the agent's configuration. Each adapter handles provider-specific headers, URL construction, and error mapping.

6. **Upstream Proxy** — The request is sent to the LLM provider using undici. Streaming responses are piped through an SSE transform that forwards chunks to the client while accumulating content for tracing.

7. **Trace Recording** — Request metadata, token usage, latency, and response content are written to the trace buffer. The `TraceRecorder` singleton flushes every 5 seconds or 100 rows, whichever comes first. Trace writes never block the response.

## Authentication Model

Arachne has three distinct authentication domains:

| Domain | Mechanism | Use Case |
|--------|-----------|----------|
| **Gateway** | API key (SHA-256 hashed) | Client applications calling `/v1/chat/completions` |
| **Portal** | JWT (HMAC-SHA256) | Tenant users managing resources in the portal UI |
| **Admin** | JWT (HMAC-SHA256) | Operators managing system-wide configuration |

Each domain uses a separate signing secret, ensuring complete isolation between user tiers.

## Encryption

All sensitive data is encrypted at rest using AES-256-GCM:

- **Key derivation** — `HMAC-SHA256(ENCRYPTION_MASTER_KEY, tenantId)` produces a unique data encryption key (DEK) per tenant.
- **Encrypted fields** — Trace bodies, conversation messages, conversation snapshots, and provider API keys.
- **Storage format** — `encrypted:{ciphertext}:{iv}` for inline encrypted strings.

This ensures that even with database access, tenant data cannot be read without the master key, and one tenant's DEK cannot decrypt another tenant's data.

## Multi-Tenancy

Arachne is multi-tenant by design:

- **Tenant isolation** — Every database query filters by `tenant_id`. There is no shared state between tenants.
- **Subtenant hierarchy** — Tenants can have parent-child relationships via `tenants.parent_id`. Configuration is resolved by walking the parent chain using a recursive CTE, allowing inherited defaults.
- **Multi-membership** — Users can belong to multiple tenants via `tenant_memberships`. Tenant switching issues a new JWT scoped to the selected tenant.
- **API key binding** — Each API key is bound to exactly one tenant and one agent.

## Provider Adapter Pattern

Providers are implemented as adapters extending the `BaseProvider` abstract class:

```
BaseProvider (abstract)
  ├── OpenAIProvider
  ├── AzureProvider
  └── OllamaProvider
```

Each adapter handles:

- **URL construction** — Mapping the request to the provider's endpoint format.
- **Authentication headers** — Injecting API keys, deployment names, or custom headers.
- **Request transformation** — Adding provider-specific fields (e.g., `stream_options.include_usage` for OpenAI).
- **Error mapping** — Normalizing provider error responses into a consistent format.

To add a new provider, extend `BaseProvider`, implement the `proxy()` method, and register it in the provider factory.

## Data Storage

**PostgreSQL 16** with pgvector serves as the single data store:

- **Core tables** — Tenants, users, memberships, agents, API keys, invites.
- **Traces** — Partitioned by month (`traces_YYYY_MM`) for efficient querying and retention management.
- **Knowledge bases** — Document chunks with vector embeddings for similarity search.
- **Conversations** — Message history and summarized snapshots.

### Persistence Strategy

The codebase uses two persistence approaches (migration in progress):

- **MikroORM** — Domain entities with `EntitySchema` definitions for structured CRUD operations.
- **Raw SQL via Knex** — Used in performance-sensitive paths (analytics, tracing) and legacy services.

## Performance

The gateway targets less than 20ms of added overhead per request:

- Auth lookups are LRU-cached to avoid per-request database queries.
- Trace recording is fire-and-forget, batched in memory.
- No per-chunk database writes during streaming responses.
- Provider connections use undici's HTTP/1.1 connection pooling.
