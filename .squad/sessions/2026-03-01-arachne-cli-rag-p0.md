# Session Log: Arachne CLI + RAG P0 Sprint

**Date:** 2026-03-01  
**Commit:** ca9bec2 → origin/main  
**Build:** ✅ 512 tests pass, clean

---

## Summary

Completed the Arachne CLI and RAG registry system — the largest feature sprint to date. Five squad members shipped across five parallel waves. The platform now supports a full artifact lifecycle: chunk/embed knowledge bases locally, push to the registry, deploy with scoped JDs, and inject KB context at inference time. The platform is also fully rebranded from Loom to Arachne.

---

## What Was Built

### Rebrand (Fenster)
All user-facing "Loom" strings replaced with "Arachne" across 21 files: `package.json`, gateway headers (`X-Loom-*` → `X-Arachne-*`), portal UI, dashboard UI, tests, README, RUNNING_LOCALLY.md. Variable names and infra names intentionally preserved.

### Registry Database Migration (Fenster)
`migrations/1000000000015_registry.cjs` — adds pgvector extension and 6 new tables:
- `vector_spaces` — embedding config fingerprint
- `artifacts` — content-addressed bundles (KnowledgeBase, Agent, EmbeddingAgent)
- `artifact_tags` — mutable version pointers
- `kb_chunks` — chunked content with `vector(1536)` pgvector embedding + ivfflat index
- `deployments` — runtime deployment state + scoped JWT
- `embedding_operations` / `artifact_operations` — audit logs
- 13 new RAG columns on `traces`
- `tenants.org_slug` and `agents.kind`

### Domain Entities (Verbal)
Five new entities using Peter Coad Color Modeling: `Artifact`, `VectorSpace`, `KbChunk`, `Deployment`, `ArtifactTag`. `Agent` extended with `kind: 'inference' | 'embedding'`.

### Registry Auth (Fenster)
`src/auth/registryScopes.ts`, `src/middleware/registryAuth.ts` — scope-based JWT authorization. Extended `JwtPayload` with `scopes` and `orgSlug`. All token-mint paths updated.

### WeaveService (Fenster)
`src/services/WeaveService.ts` — full chunk/embed/sign pipeline. Parses YAML specs, resolves docs (dir/zip/file), word-aligned chunking, OpenAI batched embeddings, HMAC-SHA256 signed `.tgz` output. Zero new npm dependencies (custom YAML parser, custom tar/zip).

### RegistryService (Fenster)
`src/services/RegistryService.ts` — push (sha256-idempotent), resolve, list, pull, delete for content-addressed artifacts. Atomic tag-pointer upsert pattern.

### ProvisionService (Fenster)
`src/services/ProvisionService.ts` — deploy (validates artifact + KB chunk readiness, mints 1-year scoped JWT), unprovision, listDeployments.

### EmbeddingAgentService (Fenster)
`src/services/EmbeddingAgentService.ts` — `resolveEmbedder()` (named agent → DB, else env var fallback) and `bootstrapSystemEmbedder()` (auto-provisions system embedder at gateway startup from env vars).

### Tenant org_slug (Fenster)
`src/utils/slug.ts`, Tenant entity + schema updates, `PATCH /v1/portal/settings` extended with `orgSlug`. Auto-generated on creation, configurable via PATCH, uniqueness enforced.

### Registry Gateway Routes (Fenster)
`src/routes/registry.ts` — 7 routes: push (multipart), list, pull, delete, deploy, list-deployments, unprovision. Added `@fastify/multipart`.

### Portal KB + Deployment Routes (Fenster)
6 new routes in `portal.ts`: KB list/detail/delete, deployment list/detail/unprovision.

### CLI Scaffold (McManus)
`cli/` package — `@arachne/cli`, Commander.js, 4 command stubs, config at `~/.arachne/config.json`.

### CLI Commands (McManus)
Full implementation: `arachne login` (interactive auth), `arachne weave` (chunk+embed pipeline), `arachne push` (multipart registry upload), `arachne deploy` (provision deployment). `cli/src/lib/zip.ts` helper.

### Portal UI (McManus)
- `KnowledgeBasesPage.tsx` — KB table with chunk count, searchReady badge, delete
- `DeploymentsPage.tsx` — deployment table with status, unprovision action
- `AgentEditor.tsx` — KB selector dropdown + Export YAML button
- `AppLayout.tsx` — Knowledge Bases and Deployments nav items

### RAG Retrieval at Inference Time (Kobayashi)
`src/rag/retrieval.ts` (`retrieveChunks()` via pgvector cosine similarity, `buildRagContext()`). `injectRagContext()` in `src/agent.ts`. `knowledgeBaseRef` threaded through `TenantContext`. 13 RAG trace fields wired end-to-end. Migration `0016` adds `knowledge_base_ref` to agents.

### RAG Analytics P0 (Redfoot)
Extended `analytics.ts` with `ragMetrics` (ragRequestCount, fallbackRate, avgRetrievalLatencyMs, avgChunkSimilarity, ragOverheadRatio). Extended `SummaryData` type. Added "RAG Performance" tile group to `AnalyticsSummary.tsx` (conditionally rendered).

---

## Decisions Made This Session

| # | Decision | Owner |
|---|----------|-------|
| 1 | Org slug is configurable per tenant; unique; defaults to slugified name; `PATCH /v1/portal/settings` exposes update | Michael Brown |
| 2 | RAG inference is IN SCOPE for P0 — gateway injects top-K chunks at inference time | Michael Brown |
| 3 | System embedder uses `SYSTEM_EMBEDDER_PROVIDER` / `SYSTEM_EMBEDDER_MODEL` / `SYSTEM_EMBEDDER_API_KEY` env vars as gateway fallback | Michael Brown |
| 4 | WeaveService uses zero new npm deps (custom implementations throughout) | Fenster |
| 5 | Runtime tokens are 1-year long-lived; stored as plain TEXT in DB (encryption at infra layer) | Fenster |
| 6 | RAG fallback policy: any failure logs + sets trace fields and continues without RAG (inference never blocked) | Kobayashi |
| 7 | topK hardcoded to 5 for P0; configurable in Phase 2 | Kobayashi |
| 8 | RAG context injected BEFORE `applyAgentToRequest` so agent system prompt appends on top of KB context | Kobayashi |

---

## Who Did What

| Agent | Wave | Deliverables |
|-------|------|-------------|
| **Fenster** | 0, 2, 3, 4 | Rebrand (21 files), registry migration, registry auth, WeaveService, RegistryService, ProvisionService, EmbeddingAgentService, tenant slug, registry routes (7), portal KB+deploy routes (6) |
| **McManus** | 1, 5 | CLI scaffold, CLI commands (login/weave/push/deploy + zip.ts), Portal UI (KnowledgeBasesPage, DeploymentsPage, AgentEditor KB selector + Export YAML) |
| **Verbal** | 2 | 5 domain entities (Artifact, VectorSpace, KbChunk, Deployment, ArtifactTag), Agent.kind field |
| **Kobayashi** | 4 | RAG retrieval at inference time (retrieval.ts, agent.ts injection, 13 trace fields, migration 0016) |
| **Redfoot** | 5 | RAG analytics P0 (analytics.ts ragMetrics, SummaryData type, AnalyticsSummary RAG tiles) |

---

## Phase 2 Items (Not in P0)

- Per-KB configurable topK (from KB spec)
- Azure embedding support in `embedQuery()`
- Streaming RAG support
- Citation tracking (parse `[N]` refs from response)
- Pre-aggregated hourly RAG rollup tables
- KB detail analytics tab (coverage ratio, hot chunks)
- `artifact_operations` lifecycle charts
- Agent creation/update routes exposing `knowledgeBaseRef` DTO field (Fenster handoff from Kobayashi)
