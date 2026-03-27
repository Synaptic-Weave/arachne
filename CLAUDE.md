# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Arachne** is an AI runtime, developer toolchain, and open spec for defining portable agents and knowledge bases. It's a multi-tenant AI gateway that proxies requests to any LLM provider (OpenAI, Azure, Ollama) with built-in observability, conversation memory, and RAG inference.

**Stack:** Node.js 25.2.1+, TypeScript, Fastify, PostgreSQL 16, MikroORM, undici, Vite + React

## Agentic Development Team

Claude operates as **Operator** — a team coordinator that dispatches work to specialized sub-agents. The Product Owner and Chief Architect is **Michael**.

### Team Roster (12 agents)

| Agent | Role | Sub-agent Type |
|-------|------|---------------|
| Neo | Product Vision Interpreter | Plan |
| Morpheus | Scrum Master | Plan |
| Trinity | UX Architect | Plan |
| Switch | Frontend Engineer | general-purpose |
| Tank | Backend Engineer | general-purpose |
| Architect | Domain Modeling Expert | Plan |
| Mouse | Test Engineer | general-purpose |
| Oracle | AI Systems Advisor | Plan |
| Niobe | Security Engineer | Explore / general-purpose |
| Cipher | Pentester & Attack Stories | Explore / general-purpose |
| Agent Smith | Code Review & Quality | Explore / general-purpose |
| Merovingian | System Impact Analyst | Explore |
| Link | Infrastructure Engineer | general-purpose |

Agent prompt files are in `~/.claude/projects/-Users-michaelbrown-projects-loom/memory/agents/{name}/prompt.md`.

### Operator Protocol

1. Read the agent's `prompt.md` before spawning
2. Load Tier 1 general knowledge (`~/.claude/memory/agents/{name}/general.md`) + Tier 2 project knowledge (project memory `agents/{name}/findings.md`)
3. Inject both into the agent's prompt as accumulated knowledge
4. After completion: classify new findings as general or project-specific, save to appropriate tier
5. Append a timestamped blog entry to the agent's `blog.md`

### Process (from TEAM_CHARTER.md)

- **Lean principles** — measure lead time (not velocity)
- **Swarming** — team converges on one story; unfeasibility triggers allow picking up a second
- **Vertical slices** — every story delivers user-visible value across the full stack
- **Gitflow** — feature branches off `develop`, only Michael merges to `main`
- **Branch naming** — `[type]/[issue-number]-short-title`

### Key Architectural Decisions In Progress

- **Agent Spec vs Deployment** — Agent entity is the mutable spec (testable via sandbox). Deployments are stable slots with their own API keys. Deploy weaves spec → .orb → pushes to registry → deploys to staging. Promote swaps staging → production.
- **Skills → Tools unification** — Skills (client-side), MCP endpoints (external), and Tool Packages (sandboxed) all unified under `tools`. See `docs/system_specs/`.
- **Principals** — End-user identity via `X-Arachne-Principal` header. Auto-created on first use.
- **Agent Teams** — Multi-agent coordination via coordinator pattern.
- **Unified CLI** — One set of commands (`weave/push/deploy`) for all artifact kinds. `arachne init --kind <type>` for scaffolding.

## Common Development Commands

### Environment Setup
```bash
# Install dependencies
npm install

# Start PostgreSQL (Docker Compose)
docker compose up -d postgres

# Copy environment file
cp .env.example .env
# Edit .env and set ENCRYPTION_MASTER_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Run database migrations
npm run migrate:up
```

### Development
```bash
# Start development server with hot reload
npm run dev

# Build TypeScript to JavaScript
npm run build

# Start production server
npm start
```

### Testing
```bash
# Run all tests (main project + portal)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run smoke tests (Playwright-based)
npm run test:smoke

# Run a single test file
npx vitest run tests/auth.test.ts

# Run a single test by name pattern
npx vitest run -t "should resolve tenant context"
```

### Database Migrations (MikroORM)
```bash
# Run pending migrations
npm run migrate:up

# Rollback last migration
npm run migrate:down

# Create new migration (auto-diffs entity schemas)
npm run migrate:create

# Check if schema is in sync with entities
npm run migrate:check

# List pending migrations
npm run migrate:pending
```

### Legacy Migrations (node-pg-migrate, for rollback only)
```bash
npm run legacy:migrate:up
npm run legacy:migrate:down
```

### Frontend Development
```bash
# Build portal (tenant self-service UI)
cd portal && npm run build

# Build dashboard (operator view)
cd dashboard && npm run build

# Build all frontends
npm run build:all
```

### CLI Development
```bash
# The CLI is in a workspace at cli/
cd cli
npm install
npm run build
npm link  # Make `arachne` command available locally
```

## Architecture & Code Organization

### Request Flow Architecture

The gateway follows a layered architecture with clear separation between infrastructure, domain, and application layers:

1. **Auth Middleware** (`src/auth.ts`) → Resolves API key to TenantContext via LRU cache (1,000 entries) backed by database
2. **Conversation Memory** (`ConversationManagementService`) → Loads context if agent has `conversations_enabled`, injects history/snapshots
3. **RAG Injection** (`src/agent.ts` → `injectRagContext`) → If agent has `knowledgeBaseRef`, retrieves and injects relevant chunks
4. **Agent Application** (`src/agent.ts` → `applyAgentToRequest`) → Applies merge policies for system prompts and skills
5. **Provider Routing** (`src/providers/registry.ts`) → Resolves correct provider adapter from cached `providerConfig`
6. **Proxy** → undici sends request upstream to LLM provider
7. **Trace Recording** (`src/tracing.ts`) → Fire-and-forget batch writer (5s or 100 rows)

**Streaming:** Response body is piped through SSE Transform (`src/streaming.ts`) that forwards chunks to client and accumulates content for trace recording.

**Non-streaming:** If MCP tool calls are detected, `handleMcpRoundTrip()` executes one round-trip to MCP endpoints and re-sends to the provider.

### Directory Structure

```
src/
├── index.ts                    # Server startup, route registration, main /v1/chat/completions handler
├── agent.ts                    # System prompt/skills injection, RAG context injection, MCP round-trip
├── conversations.ts            # Standalone conversation manager (raw SQL, legacy)
├── tracing.ts                  # TraceRecorder singleton with batched async flushing
├── analytics.ts                # Raw SQL analytics: summary, timeseries, model breakdown
├── streaming.ts                # SSE Transform stream for live trace capture
├── encryption.ts               # AES-256-GCM with per-tenant key derivation
├── auth.ts                     # Global API key auth middleware with LRU cache
├── orm.ts                      # MikroORM initialization (PostgreSQL/SQLite)
├── db.ts                       # Raw SQL shim backed by MikroORM's Knex instance
│
├── application/
│   ├── dtos/                   # Data transfer objects
│   └── services/               # Application services (Portal, Admin, Dashboard, etc.)
│       ├── PortalService.ts           # Tenant self-service (raw SQL via Knex)
│       ├── AdminService.ts            # System-wide admin (raw SQL via Knex)
│       ├── DashboardService.ts        # Operator dashboard (delegates to analytics)
│       ├── ConversationManagementService.ts  # Conversation lifecycle (MikroORM)
│       ├── UserManagementService.ts   # User auth (MikroORM)
│       └── TenantManagementService.ts # Tenant lifecycle (MikroORM)
│
├── domain/
│   ├── entities/               # 12 MikroORM entity classes (plain TS, no decorators)
│   ├── repositories/           # Custom repository classes
│   └── schemas/                # MikroORM EntitySchema definitions (separate from entities)
│
├── providers/
│   ├── base.ts                 # Abstract BaseProvider interface
│   ├── openai.ts               # OpenAI adapter (injects stream_options.include_usage)
│   ├── azure.ts                # Azure OpenAI adapter (maps error format)
│   └── registry.ts             # Provider factory with lazy-initialized cache
│
├── routes/
│   ├── portal.ts               # /v1/portal/* - Portal JWT auth (PORTAL_JWT_SECRET)
│   ├── admin.ts                # /v1/admin/* - Admin JWT auth (ADMIN_JWT_SECRET)
│   ├── dashboard.ts            # /v1/traces, /v1/analytics/* - Tenant API key auth
│   ├── registry.ts             # /v1/registry/* - Agent/KB artifact registry
│   └── beta.ts                 # /v1/beta/* - Beta features
│
├── middleware/
│   ├── portalAuth.ts           # Portal JWT verification
│   ├── adminAuth.ts            # Admin JWT verification
│   ├── createBearerAuth.ts     # Shared JWT Bearer token handler factory
│   └── registryAuth.ts         # Registry token verification
│
├── auth/
│   ├── jwtUtils.ts             # Core JWT operations (signJwt, verifyJwt)
│   └── registryScopes.ts       # Registry permission scopes
│
├── rag/
│   └── retrieval.ts            # Vector search and embedding generation
│
├── services/
│   └── EmbeddingAgentService.ts # System-embedder bootstrap
│
└── types/
    └── openai.ts               # OpenAI API type definitions

portal/                         # Tenant self-service UI (Vite + React)
dashboard/                      # Operator view UI (Vite + React)
cli/                           # @arachne/cli workspace (agent weave/push/deploy)
tests/                         # Vitest test suite
migrations/                    # node-pg-migrate migrations (CommonJS .cjs files)
```

### Two Persistence Strategies (In Transition)

**Legacy (raw SQL via Knex):**
- `PortalService`, `AdminService` use `src/db.ts` → Knex
- Analytics and tracing use raw SQL for performance

**Domain Layer (MikroORM):**
- `ConversationManagementService`, `UserManagementService`, `TenantManagementService` use MikroORM entities
- Uses `EntitySchema` pattern: entities are plain TypeScript classes, schemas defined separately
- Migration from legacy to domain-layer is in progress

When working with services, check which pattern they use before making changes.

### Multi-Tenancy Model

- **API Key → Tenant:** Every API key is bound to one tenant and one agent
- **Subtenant Hierarchy:** `tenants.parent_id` creates a tree; `TenantService.loadByApiKey()` walks the parent chain via recursive CTE to resolve inherited config
- **Data Isolation:** All queries filter by `tenant_id`
- **Multi-User:** Users have memberships in multiple tenants via `tenant_memberships`; JWT contains `{ sub, tenantId, role }`
- **Tenant Switching:** `POST /v1/portal/auth/switch-tenant` issues new JWT with different `tenantId`

### Authentication Domains

| Domain | Mechanism | Secret Env Var | Middleware |
|--------|-----------|----------------|------------|
| Gateway | API key (Bearer/x-api-key header) | SHA-256 hashed in DB | `src/auth.ts` (global preHandler) |
| Portal | JWT (jsonwebtoken) | `PORTAL_JWT_SECRET` | `src/middleware/portalAuth.ts` |
| Admin | JWT (jsonwebtoken) | `ADMIN_JWT_SECRET` | `src/middleware/adminAuth.ts` |

### Encryption (AES-256-GCM)

**What gets encrypted:**
- Trace request/response bodies
- Conversation messages
- Conversation snapshots
- Provider API keys (stored as `encrypted:{ciphertext}:{iv}`)

**Key derivation:** `HMAC-SHA256(ENCRYPTION_MASTER_KEY, tenantId)` → per-tenant DEK

### Database Details

**PostgreSQL 16** with pgvector extension for embeddings.

**12 Core Entities:**
- `Tenant`, `User`, `TenantMembership`, `Invite`
- `AdminUser`, `Agent`, `ApiKey`
- `Trace` (partitioned by month: `traces_YYYY_MM`)
- `Partition`, `Conversation`, `ConversationMessage`, `ConversationSnapshot`
- `Artifact`, `Deployment`, `KnowledgeBase`, `KnowledgeBaseChunk`

**Testing with SQLite:** Use `DB_DRIVER=sqlite` env var for tests that need real ORM operations without PostgreSQL.

## Testing Patterns

### Unit Tests
Mock `EntityManager` to isolate service logic:
```typescript
const mockEm = {
  findOne: vi.fn(),
  persistAndFlush: vi.fn(),
  // ...
} as any;
```

### Route Tests
Mock services to test HTTP handler behavior without database:
```typescript
const mockPortalSvc = {
  signup: vi.fn().mockResolvedValue({ token: 'abc123', ... }),
  // ...
};
```

### Integration Tests
Use SQLite driver for real ORM operations:
```bash
DB_DRIVER=sqlite npx vitest run tests/domain-entities.test.ts
```

### DB Helper Mocking
For analytics/tracing tests:
```typescript
vi.mock('../src/db.js', () => ({
  query: vi.fn(),
}));
```

## Important Implementation Notes

### Gateway Overhead Target
Keep gateway overhead < 20ms:
- Auth is LRU-cached (cache misses go to DB)
- Trace persistence is fire-and-forget (off the hot path)
- No per-chunk DB writes during streaming

### Trace Recording
`TraceRecorder` singleton accumulates traces in memory, flushes every 5s or 100 rows. Never block the response path waiting for trace writes.

### Conversation Memory
When `conversations_enabled` is true:
1. Load context (messages + snapshots)
2. Check token estimate against `conversation_token_limit`
3. If exceeded, summarize via LLM and create snapshot
4. Inject history into request messages array

### RAG Inference
When agent has `knowledgeBaseRef`:
1. Extract user query from last message
2. Generate embedding via `system-embedder` agent
3. Vector search against `knowledge_base_chunks` (pgvector)
4. Inject top-k chunks into system message
5. Record RAG metrics in trace (latency, similarity scores)

### Provider Adapter Pattern
When adding a new provider:
1. Extend `BaseProvider` abstract class in `src/providers/`
2. Implement `proxy(request: ProxyRequest): Promise<ProxyResponse>`
3. Add to factory in `src/providers/registry.ts`
4. Handle provider-specific auth headers and error formats

### Migration Strategy
New migrations use **MikroORM's migrator** (TypeScript files in `src/migrations/`):
- Create new migration: `npm run migrate:create` (auto-diffs entity schemas against snapshot)
- Review generated SQL before applying
- Apply with `npm run migrate:up`, roll back with `npm run migrate:down`
- The migrator uses a separate `mikro_orm_migrations` table for its history
- Legacy `node-pg-migrate` migrations (CommonJS `.cjs` in `migrations/`) are kept for rollback only
- See `docs/developer-guide.md` for the full migration workflow

### Frontend Serving
Both Portal and Dashboard are served as static SPAs by Fastify:
- Portal: `/` (root) via `@fastify/static`
- Dashboard: `/dashboard` via `@fastify/static`
- SPA fallback routing handled in `setNotFoundHandler`

### Smoke Tests
Playwright-based smoke tests in `tests/smoke/`:
```bash
npm run test:smoke
```

For generating docs screenshots:
```bash
npm run docs:screenshots  # DOCS_MODE=true runs smoke tests
npm run docs:generate     # Generates UI docs from screenshots
```

## Environment Variables Reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | No | `postgres://loom:loom_dev_password@localhost:5432/loom` | PostgreSQL connection |
| `ENCRYPTION_MASTER_KEY` | Yes | - | 64-char hex for AES-256-GCM |
| `ADMIN_JWT_SECRET` | Yes | - | Admin JWT signing secret |
| `PORTAL_JWT_SECRET` | Yes | - | Portal JWT signing secret |
| `OPENAI_API_KEY` | No | - | Fallback OpenAI key |
| `PORT` | No | 3000 | Server port |
| `HOST` | No | 0.0.0.0 | Bind address |
| `DB_DRIVER` | No | postgres | `postgres` or `sqlite` |
| `PORTAL_BASE_URL` | No | `http://localhost:3000` | Base URL for invite links |
| `SYSTEM_EMBEDDER_PROVIDER` | No | - | Default embedder: `openai`, `azure`, or `ollama` |
| `SYSTEM_EMBEDDER_MODEL` | No | - | Embedder model (e.g., `text-embedding-3-small`, `nomic-embed-text`) |
| `SYSTEM_EMBEDDER_API_KEY` | No | - | Embedder API key |
| `NODE_ENV` | No | - | Set to `development` for MikroORM debug logging |

## Key Design Principles

1. **Single process for Phase 1** — Gateway, dashboard API, portal API, and admin API all share one Fastify instance
2. **Provider-agnostic** — Abstract `BaseProvider` interface; tenant config determines routing
3. **Encrypt everything at rest** — All tenant data encrypted with per-tenant derived keys
4. **Fire-and-forget observability** — Trace recording never blocks the response path
5. **Two persistence paths coexist** — Legacy services use raw SQL; domain services use MikroORM (migration in progress)
6. **LRU-cached auth** — API key resolution uses 1,000-entry LRU cache to minimize DB hits

## Useful Documentation Files

- `docs/architecture.md` — Detailed component design, data flows, encryption patterns
- `docs/developer-guide.md` — Database schema, API extensions, stack details
- `RUNNING_LOCALLY.md` — Docker Compose and Node.js setup instructions
- `docs/cli.md` — CLI reference for agent weave/push/deploy
- `docs/rag-inference.md` — RAG retrieval and embedding pipeline
- `docs/portal-guide.md` — Portal UI usage guide
- `docs/product-roadmap.md` — 4-phase product roadmap (beta → production → differentiation → ecosystem)
- `docs/feature-roadmap.md` — 60+ features across 10 categories with priorities
- `docs/system_specs/agent_tools.md` — Tool execution specification (draft)
- `docs/system_specs/arachne_tool_package_spec.md` — Tool package format specification (draft)
- `TEAM_CHARTER.md` — Team process, quality standards, gitflow, definition of done
