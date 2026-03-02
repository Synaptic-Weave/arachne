# Loom Architecture

> Canonical architecture reference for the Loom AI gateway. Reflects the codebase as-built.

## 1. System Overview

Loom is a **provider-agnostic, OpenAI-compatible AI gateway** that proxies requests to LLM providers (OpenAI, Azure OpenAI, Ollama) while adding:

- **Multi-tenant isolation** — API key-based tenancy with per-tenant provider configuration
- **Structured trace recording** — Encrypted request/response audit trail with batched async persistence
- **Conversation memory** — Persistent multi-turn conversations with automatic token-aware summarization
- **Agent management** — Configurable agents with system prompt injection, tool/skill merging, and MCP round-trip support
- **Analytics & observability** — Token usage, latency percentiles, cost estimation, gateway overhead tracking
- **Three frontends** — Portal (tenant self-service), Dashboard (operator view), Admin (system-wide management)

**Stack:** Node.js + TypeScript, Fastify, PostgreSQL, MikroORM, undici, Vite + React

---

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph Clients
        SDK[OpenAI SDK / HTTP Client]
        PortalUI[Portal UI<br/>localhost:3000/]
        DashUI[Dashboard UI<br/>localhost:3000/dashboard]
    end

    subgraph "Fastify Process (single)"
        GW[Gateway<br/>POST /v1/chat/completions]
        Auth[Auth Middleware<br/>API Key → TenantContext]
        Agent[Agent Engine<br/>system prompt, skills, MCP]
        ConvMem[Conversation Memory<br/>context injection, summarization]
        SSE[SSE Streaming Proxy<br/>Transform stream tee]
        Trace[Trace Recorder<br/>batched async flush]

        PortalAPI[Portal Routes<br/>/v1/portal/*]
        DashAPI[Dashboard Routes<br/>/v1/traces, /v1/analytics/*]
        AdminAPI[Admin Routes<br/>/v1/admin/*]

        PortalAuth[Portal Auth<br/>jsonwebtoken]
        AdminAuth[Admin Auth<br/>jsonwebtoken]

        Analytics[Analytics Engine<br/>summary, timeseries, model breakdown]

        Services[Application Services<br/>PortalService, AdminService,<br/>DashboardService, ConversationMgmt,<br/>UserMgmt, TenantMgmt]

        Domain[Domain Layer<br/>Entities, Repositories, Schemas]
        ORM[MikroORM + Knex]
    end

    subgraph Providers
        OpenAI[OpenAI API]
        Azure[Azure OpenAI]
        Ollama[Ollama Local]
    end

    subgraph Data
        PG[(PostgreSQL 16)]
    end

    SDK --> Auth --> GW
    GW --> Agent --> ConvMem
    ConvMem --> SSE
    GW --> Trace
    SSE --> Trace
    GW -->|undici| OpenAI
    GW -->|undici| Azure
    GW -->|undici| Ollama

    PortalUI --> PortalAPI
    DashUI --> DashAPI

    PortalAPI --> PortalAuth
    AdminAPI --> AdminAuth
    DashAPI --> Auth

    PortalAPI --> Services
    AdminAPI --> Services
    DashAPI --> Services
    Services --> Domain --> ORM --> PG
    Analytics --> PG
    Trace --> PG
```

---

## 3. Component Breakdown

### 3.1 Gateway / Proxy Layer

**Entry point:** `src/index.ts` → `POST /v1/chat/completions`

The gateway is the core of Loom. A single Fastify route handles all LLM proxy traffic:

1. **Auth middleware** (`src/auth.ts`) resolves the API key to a `TenantContext` via SHA-256 hash lookup against an LRU cache (1,000 entries) backed by the database
2. **Conversation memory** (`ConversationManagementService`) loads context if the agent has `conversations_enabled` — injects history/snapshots into the message array
3. **Agent application** (`src/agent.ts` → `applyAgentToRequest()`) applies merge policies for system prompts and skills
4. **Provider routing** (`src/providers/registry.ts`) resolves the correct provider adapter from cached `providerConfig`
5. **Proxy** — undici sends the request upstream

**Streaming path:** For `stream: true` requests, the response body is piped through an SSE Transform (`src/streaming.ts`) that simultaneously forwards chunks to the client and accumulates content for trace recording.

**Non-streaming path:** JSON response is captured directly. If MCP tool calls are detected, `handleMcpRoundTrip()` executes one round-trip to MCP endpoints and re-sends to the provider.

**Response extensions:**
- `conversation_id` and `partition_id` echoed back when conversation memory is active
- `X-Loom-Conversation-ID` header with the internal UUID

### 3.2 Application Services

**Location:** `src/application/services/`

| Service | Responsibility |
|---------|---------------|
| `PortalService` | Tenant self-service: signup, login, tenant switching, API key CRUD, agent CRUD, provider config, conversation/partition management. Raw SQL via Knex. |
| `AdminService` | System-wide admin: tenant CRUD, API key management, trace listing, login validation. Raw SQL via Knex. |
| `DashboardService` | Operator dashboard: paginated traces, analytics summary, timeseries metrics. Delegates to analytics module. |
| `ConversationManagementService` | Conversation lifecycle: get/create conversations & partitions, load context, store messages, create snapshots. Uses MikroORM entities. |
| `UserManagementService` | User auth: signup, login, invite acceptance. Uses MikroORM entities. |
| `TenantManagementService` | Tenant lifecycle: create, update, subtenant creation, membership management. Uses MikroORM entities. |
| `TenantService` | API key → tenant resolution: `loadByApiKey()` with recursive CTE for parent chain resolution (provider config, system prompt, skills, MCP endpoints). Uses MikroORM entities. |

**Architecture note:** Two persistence strategies coexist. Legacy services (`PortalService`, `AdminService`) use raw SQL via `src/db.ts` → Knex. Domain-layer services use MikroORM entities. Migration from legacy to domain-layer is in progress.

### 3.3 Domain Layer

**Location:** `src/domain/`

```
src/domain/
├── entities/       # 12 MikroORM entity classes
│   ├── Tenant.ts
│   ├── User.ts
│   ├── TenantMembership.ts
│   ├── Invite.ts
│   ├── AdminUser.ts
│   ├── Agent.ts
│   ├── ApiKey.ts
│   ├── Trace.ts
│   ├── Partition.ts
│   ├── Conversation.ts
│   ├── ConversationMessage.ts
│   └── ConversationSnapshot.ts
├── repositories/   # Custom repository classes
│   ├── TenantRepository.ts
│   ├── UserRepository.ts
│   ├── AgentRepository.ts
│   ├── ApiKeyRepository.ts
│   ├── ConversationRepository.ts
│   ├── TraceRepository.ts
│   └── AdminUserRepository.ts
└── schemas/        # MikroORM EntitySchema definitions
    ├── Tenant.schema.ts
    ├── User.schema.ts
    └── ... (one per entity)
```

The domain layer uses MikroORM's `EntitySchema` pattern (separate schema files) rather than decorator-based entities, keeping entities as plain TypeScript classes.

### 3.4 Infrastructure

| File | Purpose |
|------|---------|
| `src/orm.ts` | MikroORM initialization. Supports PostgreSQL (production) and Better-SQLite (testing) via `DB_DRIVER` env var. |
| `src/db.ts` | Thin raw SQL shim — exposes `query()` backed by MikroORM's embedded Knex instance. Used by analytics, tracing, and legacy services. |
| `src/encryption.ts` | AES-256-GCM encryption. Master key from `ENCRYPTION_MASTER_KEY` env var. Per-tenant key derivation via HMAC-SHA256. Used for trace bodies, conversation messages, snapshots, and provider API keys. |
| `src/tracing.ts` | `TraceRecorder` singleton — fire-and-forget batch writer. Accumulates traces in memory, flushes every 5s or 100 rows. |
| `src/analytics.ts` | Raw SQL analytics: summary, timeseries, model breakdown. Supports subtenant rollup via recursive CTE. Inline cost estimation per model. |
| `src/streaming.ts` | Node.js Transform stream that tees SSE data — forwards to client immediately, parses `data:` lines in the background, records trace on `flush`. |
| `src/conversations.ts` | Standalone conversation manager (raw SQL). Partition resolution, context loading, message encryption, snapshot creation. |

### 3.5 Routes

**Location:** `src/routes/`

| File | Prefix | Auth | Endpoints |
|------|--------|------|-----------|
| `portal.ts` | `/v1/portal/*` | Portal JWT (`PORTAL_JWT_SECRET`, jsonwebtoken) | Signup, login, tenant switching, API key CRUD, agent CRUD, subtenant management, conversation/partition CRUD, provider config, analytics, traces |
| `admin.ts` | `/v1/admin/*` | Admin JWT (`ADMIN_JWT_SECRET`, jsonwebtoken) | Login, tenant CRUD, API key CRUD, provider config, traces, analytics (summary, timeseries, model breakdown) |
| `dashboard.ts` | `/v1/traces`, `/v1/analytics/*` | Tenant API key (same as gateway) | Paginated traces, analytics summary, timeseries |

**Gateway route:** `POST /v1/chat/completions` is registered directly in `src/index.ts` (not in routes/).

### 3.6 Frontends

| App | Location | Served At | Tech | Purpose |
|-----|----------|-----------|------|---------|
| **Portal** | `portal/` | `/` (root) | Vite + React | Tenant self-service: signup, login, manage agents, API keys, conversations, analytics |
| **Dashboard** | `dashboard/` | `/dashboard` | Vite + React | Operator view: traces, analytics charts |

Both are built as static SPAs and served by `@fastify/static` from the Fastify process. SPA fallback routing is handled in `setNotFoundHandler` — Dashboard routes → `dashboard/dist/index.html`, non-API routes → `portal/dist/index.html`.

Admin routes (`/v1/admin/*`) are API-only with no dedicated frontend yet.

---

## 4. Request Data Flow

### Gateway Request (Non-Streaming)

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as Gateway
    participant Auth as Auth Middleware
    participant LRU as LRU Cache
    participant DB as PostgreSQL
    participant Agent as Agent Engine
    participant Conv as Conversation Memory
    participant P as LLM Provider
    participant TR as Trace Recorder

    C->>GW: POST /v1/chat/completions
    GW->>Auth: preHandler hook
    Auth->>LRU: lookup(sha256(apiKey))
    alt Cache miss
        LRU-->>Auth: miss
        Auth->>DB: TenantService.loadByApiKey()
        DB-->>Auth: TenantContext
        Auth->>LRU: cache(keyHash, context)
    else Cache hit
        LRU-->>Auth: TenantContext
    end
    Auth-->>GW: request.tenant = TenantContext

    GW->>Conv: loadContext() if conversations_enabled
    Conv->>DB: messages + snapshots
    Conv-->>GW: historyMessages[]

    GW->>Agent: applyAgentToRequest(body, tenant)
    Agent-->>GW: body with injected system prompt + tools

    GW->>P: undici.request(upstream)
    P-->>GW: JSON response

    GW->>TR: record(trace) [fire-and-forget]
    TR-->>DB: batch INSERT (async, ≤5s / 100 rows)

    GW-->>C: JSON response
```

### Gateway Request (Streaming)

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as Gateway
    participant P as LLM Provider
    participant SSE as SSE Transform
    participant TR as Trace Recorder
    participant DB as PostgreSQL

    GW->>P: undici.request(upstream, stream: true)
    P-->>SSE: text/event-stream chunks
    SSE->>C: forward each chunk immediately
    SSE->>SSE: parse data: lines, accumulate content
    Note over SSE: On stream end (flush)
    SSE->>TR: record(accumulated trace)
    TR-->>DB: batch INSERT (async)
```

---

## 5. Multi-Tenancy Model

### Entity Structure

```mermaid
erDiagram
    USERS ||--o{ TENANT_MEMBERSHIPS : "has memberships"
    TENANTS ||--o{ TENANT_MEMBERSHIPS : "has members"
    TENANTS ||--o{ API_KEYS : "has keys"
    TENANTS ||--o{ AGENTS : "has agents"
    TENANTS ||--o{ TRACES : "has traces"
    TENANTS ||--o| TENANTS : "parent_id (subtenant)"
    TENANTS ||--o{ INVITES : "has invites"
    AGENTS ||--o{ API_KEYS : "agent_id"
    AGENTS ||--o{ TRACES : "agent_id"

    USERS {
        uuid id PK
        varchar email UK
        varchar password_hash
    }
    TENANTS {
        uuid id PK
        varchar name
        varchar status
        uuid parent_id FK
        jsonb provider_config
    }
    TENANT_MEMBERSHIPS {
        uuid id PK
        uuid user_id FK
        uuid tenant_id FK
        varchar role
    }
```

### Isolation Mechanics

- **API key → Tenant:** Every API key is bound to one tenant and one agent. The auth middleware resolves `key_hash` → `TenantContext` containing tenant ID, agent ID, provider config, and agent config.
- **Subtenant hierarchy:** `tenants.parent_id` creates a tree. `TenantService.loadByApiKey()` walks the parent chain via recursive CTE to resolve inherited `provider_config`, `system_prompt`, `skills`, and `mcp_endpoints`.
- **Data isolation:** All queries filter by `tenant_id`. Analytics supports subtenant rollup via recursive CTE.
- **Multi-user:** Users have memberships in multiple tenants via `tenant_memberships`. JWT contains `{ sub, tenantId, role }`. Tenant switching issues a new JWT via `POST /v1/portal/auth/switch-tenant`.
- **Invite system:** `invites` table with tokens, `max_uses`, expiry. New users join via invite link; existing users gain a new membership.

### Tenant Lifecycle

| Status | Effect |
|--------|--------|
| `active` | Normal operation |
| `inactive` | Auth middleware rejects API keys; cache invalidated |

API keys have `active` / `revoked` status. Revoked keys are removed from the LRU cache immediately.

---

## 6. Authentication & Authorization

### Three Auth Domains

| Domain | Mechanism | Secret | Middleware |
|--------|-----------|--------|------------|
| **Gateway** | API key (Bearer / x-api-key header) | SHA-256 hashed, stored in `api_keys.key_hash` | `src/auth.ts` → global `preHandler` hook |
| **Portal** | JWT (jsonwebtoken) | `PORTAL_JWT_SECRET` env var | `src/middleware/portalAuth.ts` + `src/middleware/createBearerAuth.ts` |
| **Admin** | JWT (jsonwebtoken) | `ADMIN_JWT_SECRET` env var | `src/middleware/adminAuth.ts` + `src/middleware/createBearerAuth.ts` |

### JWT Implementation

Admin and Portal JWT auth are unified via shared utilities:
- `src/auth/jwtUtils.ts` — Core JWT operations (`signJwt`, `verifyJwt`) using `jsonwebtoken` library
- `src/middleware/createBearerAuth.ts` — Shared preHandler factory that handles Bearer token extraction, verification, claims extraction, and standardized 401 responses
- `adminAuth.ts` and `portalAuth.ts` invoke `createBearerAuth()` with their respective secrets

### Auth Skip List

The global API key middleware skips: `/health`, `/favicon.ico`, `/dashboard*`, `/v1/admin/*`, `/v1/portal/*`, and any non-`/v1/` path.

### API Key Format

```
loom_sk_{prefix}_{random}
```

- Key prefix (first 12 chars) stored for UI display
- Full key SHA-256 hashed for database lookup
- Keys are never stored in plaintext; raw key shown only at creation time

### Portal Auth Flow

1. `POST /v1/portal/auth/signup` → creates user + tenant + default agent + API key → signs JWT via `signJwt()` → returns JWT
2. `POST /v1/portal/auth/login` → validates email/password (scrypt) → signs JWT via `signJwt()` → returns JWT + tenant list
3. `POST /v1/portal/auth/switch-tenant` → validates membership → signs new JWT with different `tenantId`
4. All other `/v1/portal/*` routes verify Bearer token via `createBearerAuth(PORTAL_JWT_SECRET)`

### Admin Auth Flow

1. `POST /v1/admin/auth/login` → validates username/password (scrypt) → signs JWT via `signJwt()` (8h expiry) → returns JWT
2. All other `/v1/admin/*` routes verify Bearer token via `createBearerAuth(ADMIN_JWT_SECRET)`

---

## 7. Database & Persistence

### Stack

- **PostgreSQL 16** (Alpine, via docker-compose)
- **MikroORM** with `EntitySchema` pattern (entities are plain TS classes, schemas defined separately)
- **Knex** (embedded in MikroORM) for raw SQL queries used by analytics, tracing, and legacy services
- **Better-SQLite** driver available via `DB_DRIVER=sqlite` for testing

### Connection

```
DATABASE_URL=postgres://loom:loom_dev_password@localhost:5432/loom
```

### Entity Relationships

12 core entities: `Tenant`, `User`, `TenantMembership`, `Invite`, `AdminUser`, `Agent`, `ApiKey`, `Trace`, `Partition`, `Conversation`, `ConversationMessage`, `ConversationSnapshot`

### Migration Strategy

14 sequential migrations in `migrations/` using CommonJS (`.cjs`):

| Migration | Purpose |
|-----------|---------|
| `0001` | Create `tenants` table |
| `0002` | Create `api_keys` table |
| `0003` | Create `traces` table with `encryption_key_version` |
| `0004` | Add `provider_config` JSONB to tenants |
| `0005` | Add trace indexes |
| `0006` | Add `status_code` to traces |
| `0007` | Add `status`/`updated_at` to tenants |
| `0008` | Add `name`/`key_prefix`/`status`/`revoked_at` to api_keys |
| `0009` | Create `admin_users` table |
| `0010` | Create `tenant_users` table |
| `0011` | Multi-tenant users: create `users` + `tenant_memberships`, migrate from `tenant_users`, create `invites` |
| `0012` | Subtenant hierarchy (`parent_id`), `agents` table, agent-linked API keys/traces |
| `0013` | Add `available_models` |
| `0014` | Conversations: `conversations`, `conversation_messages`, `conversation_snapshots`, `partitions` |

Traces are **partitioned by month** (`traces_YYYY_MM` child tables) for efficient querying and retention.

---

## 8. Analytics Pipeline

**Location:** `src/analytics.ts`

Analytics are computed **on-read** from the `traces` table via raw SQL — no pre-aggregation or materialized views.

### Query Types

| Function | Output |
|----------|--------|
| `getAnalyticsSummary()` | Total requests, tokens, cost, avg/p95/p99 latency, error rate, avg overhead, avg TTFB |
| `getTimeseriesMetrics()` | Time-bucketed version of above (configurable bucket size, default 60 min) |
| `getModelBreakdown()` | Per-model request counts, error rates, latency, tokens, cost |

### Cost Estimation

Inline SQL `CASE` expression applies per-model token rates:

| Model | Input Rate (per token) | Output Rate (per token) |
|-------|----------------------|------------------------|
| GPT-3.5 / GPT-35 | $0.0000005 | $0.0000015 |
| All others (default) | $0.000005 | $0.000015 |

### Subtenant Rollup

When `rollup=true`, a recursive CTE resolves the tenant and all descendants:

```sql
WITH RECURSIVE subtenant_tree AS (
  SELECT id FROM tenants WHERE id = $1
  UNION ALL
  SELECT t.id FROM tenants t JOIN subtenant_tree st ON t.parent_id = st.id
)
```

### Admin Analytics

Separate functions (`getAdminAnalyticsSummary`, `getAdminTimeseriesMetrics`, `getAdminModelBreakdown`) operate across all tenants or filtered to one.

---

## 9. Provider Abstraction

**Location:** `src/providers/`

```mermaid
classDiagram
    class BaseProvider {
        <<abstract>>
        +name: string
        +proxy(request): ProxyResponse
        #getAuthHeader(): string
    }
    class OpenAIProvider {
        +name = "openai"
        +proxy(request): ProxyResponse
    }
    class AzureProvider {
        +name = "azure"
        +proxy(request): ProxyResponse
    }
    BaseProvider <|-- OpenAIProvider
    BaseProvider <|-- AzureProvider
```

| Provider | URL Pattern | Auth Header | Notes |
|----------|-------------|-------------|-------|
| OpenAI | `{baseUrl}/v1/chat/completions` | `Authorization: Bearer {key}` | Injects `stream_options.include_usage` for streaming |
| Azure | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={ver}` | `api-key: {key}` | Maps Azure error format to OpenAI-compatible |
| Ollama | `{baseUrl}/v1/chat/completions` | `Bearer ollama` (ignored) | Uses OpenAI adapter with custom baseUrl |

**Registry** (`src/providers/registry.ts`): Factory with lazy-initialized cache. Provider instances are keyed by `agentId` (or `tenantId` fallback) and cached until explicitly evicted. Encrypted API keys in `provider_config` are decrypted on provider creation.

---

## 10. Encryption

### Pattern: AES-256-GCM with Envelope Encryption

```
ENCRYPTION_MASTER_KEY (32 bytes, hex, env var)
        │
        ▼
  HMAC-SHA256(masterKey, tenantId) → per-tenant DEK (32 bytes)
        │
        ▼
  AES-256-GCM encrypt(plaintext, DEK, random IV)
        │
        ▼
  ciphertext (hex) + IV (hex) + auth tag (appended)
```

### What Gets Encrypted

| Data | Encrypt Location | Decrypt Location |
|------|-----------------|-----------------|
| Trace request/response bodies | `tracing.ts` on batch flush | Dashboard/Portal on read |
| Conversation messages | `ConversationManagementService` on store | `ConversationManagementService` on load |
| Conversation snapshots | On creation | On context load |
| Provider API keys | Admin/Portal routes on write | `registry.ts` on provider init |

Provider API keys use a special format: `encrypted:{ciphertext}:{iv}` stored in the JSONB `provider_config` field.

---

## 11. Testing Strategy

**Framework:** Vitest (v8 coverage provider)

**Location:** `tests/`

| Test File | What It Tests |
|-----------|---------------|
| `auth.test.ts` | API key validation, LRU cache, tenant resolution |
| `proxy.test.ts` | Gateway proxy correctness, header forwarding |
| `providers.test.ts` | OpenAI & Azure adapter behavior |
| `streaming-traces.test.ts` | SSE stream tee, trace capture |
| `encryption.test.ts` | AES-256-GCM encrypt/decrypt round-trip |
| `encryption-at-rest.test.ts` | End-to-end trace encryption |
| `analytics.test.ts` | Summary, timeseries, model breakdown |
| `multi-tenant.test.ts` | Tenant isolation |
| `conversations.test.ts` | Conversation lifecycle, summarization |
| `admin.test.ts` | Admin routes and JWT auth |
| `portal-routes.test.ts` | Portal API endpoints |
| `dashboard-routes.test.ts` | Dashboard trace/analytics endpoints |
| `domain-entities.test.ts` | MikroORM entity behavior |
| `repositories.test.ts` | Repository layer queries |
| `application-services.test.ts` | Service-layer logic |

**Testing patterns:**
- **Unit tests** mock `EntityManager` to isolate service logic
- **Route tests** mock services to test HTTP handler behavior
- **DB helper** mock via `vi.mock('../src/db.js')` for analytics/tracing tests
- **SQLite driver** (`DB_DRIVER=sqlite`) for integration tests needing real ORM operations

**Configuration:**
- `vitest.config.ts` — Main test config (excludes portal/)
- `vitest.smoke.config.ts` — Smoke tests
- `vitest.workspace.ts` — Workspace config
- Coverage excludes: tests, configs, node_modules, dist, migrations, scripts, dashboard, mocks

---

## 12. Configuration & Deployment

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ENCRYPTION_MASTER_KEY` | Yes | 32-byte hex key for AES-256-GCM encryption |
| `ADMIN_JWT_SECRET` | Yes | Secret for admin JWT signing |
| `PORTAL_JWT_SECRET` | Yes | Secret for portal JWT signing |
| `DATABASE_URL` | No | PostgreSQL connection string (default: `postgres://loom:loom_dev_password@localhost:5432/loom`) |
| `OPENAI_API_KEY` | No | Fallback OpenAI key when tenant has no `provider_config` |
| `PORT` | No | Server port (default: 3000) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `DB_DRIVER` | No | `postgres` (default) or `sqlite` |
| `PORTAL_BASE_URL` | No | Base URL for invite links (default: `http://localhost:3000`) |
| `NODE_ENV` | No | Set to `development` for MikroORM debug logging |

### Docker Compose Topology

```yaml
services:
  postgres:        # PostgreSQL 16 Alpine
    ports: 5432
    volumes: postgres_data (persistent)
```

The application server is run directly (not containerized) — `docker-compose.yml` provides only the database.

### Service Architecture

Single Fastify process serves everything:

```
Port 3000
├── /                         → Portal SPA (static)
├── /dashboard                → Dashboard SPA (static)
├── /health                   → Health check
├── /v1/chat/completions      → Gateway proxy
├── /v1/traces                → Dashboard API
├── /v1/analytics/*           → Dashboard API
├── /v1/portal/*              → Portal API
└── /v1/admin/*               → Admin API
```

### Build & Run

```bash
# Database
docker compose up -d

# Build frontends
cd dashboard && npm run build && cd ..
cd portal && npm run build && cd ..

# Run server
npm run build && npm start
```

---

## 13. Key Design Principles

1. **Gateway overhead < 20ms** — Auth is LRU-cached, trace persistence is fire-and-forget (off the hot path), no per-chunk DB writes during streaming
2. **Encrypt everything at rest** — All tenant data (traces, conversations, provider keys) encrypted with per-tenant derived keys
3. **Single process for Phase 1** — Gateway, dashboard API, portal API, and admin API all share one Fastify instance. Service split is deferred to Phase 2.
4. **Two persistence paths** — Legacy services use raw SQL (battle-tested); domain services use MikroORM (clean architecture). Migration in progress.
5. **Provider-agnostic** — Abstract `BaseProvider` interface; tenant config determines routing. Adding a provider means one new adapter class.

---

## Further Reading

| Doc | What's in it |
|---|---|
| [Developer Guide](developer-guide.md) | Source layout, database schema, API extensions |
| [CLI Overview](cli-overview.md) | Artifact model, weave pipeline, registry, deployment |
| [Registry API](registry-api.md) | HTTP API for the artifact registry |
