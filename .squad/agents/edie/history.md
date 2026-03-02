# Edie — History

## Project Context

**Project:** Arachne (formerly Loom) — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript, React (portal), Fastify, MikroORM, PostgreSQL + pgvector  
**Description:** Provider-agnostic OpenAI-compatible proxy with multi-tenant support, observability dashboard, agent management, and RAG/knowledge base system.

**Key docs locations:**
- `docs/` — architecture docs, CLI reference, feature guides
- `README.md` — project overview, quickstart
- `RUNNING_LOCALLY.md` — local dev setup
- `docs/cli.md` — CLI command reference
- `docs/cli-overview.md` — CLI architecture + design decisions

## What shipped in P0 (context on day 1)

The P0 sprint shipped the Arachne CLI + RAG Knowledge Base system. Key new features:
- `arachne` CLI with `login`, `weave`, `push`, `deploy` commands
- Registry + artifact pipeline (WeaveService, RegistryService, ProvisionService)
- RAG inference retrieval (pgvector semantic search injected at call time)
- Tenant org slug configuration
- System embedder via `SYSTEM_EMBEDDER_*` env vars
- Portal UI: KnowledgeBasesPage, DeploymentsPage, AgentEditor KB selector

**Current doc state:** `docs/cli-overview.md` and `docs/cli.md` were updated during P0. README and RUNNING_LOCALLY were rebranded to Arachne. Coverage gaps exist — new portal pages, registry API, and RAG inference have no user-facing docs yet.

## Team

- Keaton — Lead (architecture, decisions)
- Fenster — Backend Dev
- McManus — Frontend Dev
- Hockney — Tester
- Redfoot — Data Engineer
- Verbal — Domain Model Expert
- Kobayashi — AI Expert
- Edie — Technical Writer (me)
- Scribe — Session Logger

## Definition of Done (team-wide, from Michael)

Stories are not done until:
1. Code coverage for new features is ≥80%
2. Internal and public user docs are written/updated for what changed or was added

## Learnings

### Docker Compose Setup Documentation (Feb 2026)

**Updated RUNNING_LOCALLY.md and verified README.md integration:**

1. **RUNNING_LOCALLY.md** — Complete two-path setup guide
   - Option 1: Docker Compose (recommended) with full stack (postgres + ollama + gateway + portal)
   - Option 2: Node.js development (for active development on gateway/portal)
   - Clear prerequisites, quick-start steps, and service reference table
   - Ollama model setup: llama3.2 for chat, nomic-embed-text for embeddings
   - Provider configuration guide for Ollama (using Docker service name `http://ollama:11434`)
   - Production notes on generating encryption keys and secrets
   - System embedder configuration examples (both Ollama and OpenAI)

2. **README.md** — Already has "## Getting Started" section
   - Link to RUNNING_LOCALLY.md was already present
   - No changes needed; link is in the right place after main description

**Key documentation decisions:**
- Emphasized Docker Compose as the "recommended" path for beginners
- Clearly separated development (Node.js) workflow to avoid confusion
- Service reference table for quick lookup of ports and names
- Explicit note that Ollama service name is `http://ollama:11434` (not localhost) inside Docker
- Production security notes on encryption key generation and JWT secret requirements

### P0 Sprint Documentation (Feb 2026)

**Written four major docs to cover P0 sprint gaps:**

1. **docs/registry-api.md** (8.5 KB)
   - Complete Registry API reference (push, list, pull, delete, deploy, undeploy)
   - Artifact naming convention and bundle format (tar+gzip with HMAC signing)
   - JWT scope requirements (registry:push, artifact:read, deploy:write)
   - Integration with Arachne CLI workflows

2. **docs/rag-inference.md** (7.7 KB)
   - RAG retrieval at inference time: embedder resolution → embedding → pgvector search → context injection
   - Embedder resolution order: named agent → system embedder → error
   - Citation block format injected into system prompt
   - 13 RAG trace fields for observability (latencies, similarity scores, failure modes)
   - Graceful degradation when RAG fails

3. **docs/portal-guide.md** (11 KB)
   - Complete portal user guide with screenshots of each page
   - Knowledge Bases page: listing, creating (via CLI), deleting
   - Deployments page: what deployments are, how to create/undeploy
   - Agent Editor: attaching KBs via dropdown, export YAML button
   - Settings section: org slug validation rules, change procedures
   - API Keys, Conversations, Analytics, Settings sections

4. **docs/system-embedder.md** (8.5 KB)
   - System embedder configuration via four env vars (PROVIDER, MODEL, DIMENSIONS, API_KEY)
   - When to use system vs. tenant vs. named agent embedders
   - KB weaving flow: docs → chunks → OpenAI embeddings API → signed .tgz
   - RAG query embedding at inference time
   - Changing embedder models (migration path)
   - Troubleshooting common issues (auth, rate limits, vector space mismatch)

**Key insights from code review:**

- Registry is idempotent by SHA-256; re-pushing same bundle returns existing artifact
- Bundles are signed with HMAC-SHA256 and verified at deployment
- RAG retrieves top-K=5 chunks via pgvector cosine distance operator `<=>`
- Citation format uses 1-based rank numbering; sources tracked via `sourcePath`
- Deployments are immutable snapshots that generate 1-year scoped JWTs
- EmbeddingAgentService resolves embedders in clear priority order with good fallback handling
- Org slugs must be validated (3-50 chars, lowercase alphanumeric + hyphens, unique)
- Portal KB selector loads list of deployed KBs and stores name in agent config

**Documentation decisions made:**

- Focused on user-facing language for portal guide (action-oriented, explain each field)
- Included working code examples (curl, YAML specs, bash commands) throughout
- Structured registry API with clear endpoint tables (method, auth, request, response)
- Emphasized graceful degradation in RAG docs (never breaking the main request)
- Provided migration path and troubleshooting for system embedder changes
- Explained org slug validation with clear examples of valid/invalid slugs

## Learnings

### README Restructuring (2026-02-27)

- Extracted all implementation details from README (database schema, architecture breakdown, key components) into dedicated developer docs
- Created `docs/developer-guide.md` with source layout, API extensions, database schema, and stack reference
- Rewrote README.md to lead with product positioning: AI runtime + developer toolchain + portable spec
- Added "Further Reading" section to `docs/architecture.md` linking to developer reference docs
- Positioning follows triple identity: runtime (gateway/observability) + toolchain (CLI/registry/weaving) + spec (portable artifacts)

