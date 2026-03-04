# Kobayashi — History

## Core Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**Joined:** 2026-03-01

## Learnings

### 2026-03-01: RAG Analytics Metrics Design

**Context:** Designed comprehensive RAG-specific metrics for Loom gateway layer when agents use `knowledgeBaseRef`. RAG flow: (1) embed query via EmbeddingAgent, (2) pgvector similarity search on `kb_chunks`, (3) inject chunks + citations into system prompt, (4) forward to provider.

**Key Decisions:**

**Raw Signals (Captured at Gateway):**
- **Embedding metrics:** `embedding_latency_ms`, `embedding_token_count`, `embedding_model` — captured per-request after embedding completes
- **Retrieval metrics:** `retrieval_latency_ms`, `chunks_retrieved_count`, `chunks_requested_k`, `retrieval_similarity_scores` (JSONB array) — captured after pgvector SELECT
- **Context injection:** `context_tokens_added`, `context_injection_position`, `original_prompt_tokens` — measured before/after augmentation
- **Chunk utilization:** `chunks_cited_count` (parse response for citations), `chunk_ids_retrieved` (JSONB array) — enables precision tracking
- **Cost attribution:** `rag_overhead_tokens` (prompt_tokens - original_prompt_tokens), `rag_cost_overhead_usd` — pre-computed at capture time
- **Failure modes:** `rag_stage_failed` (enum: embedding|retrieval|injection|none), `fallback_to_no_rag` (boolean) — isolates failure points

**Derived Signals (Redfoot Aggregates):**
- **Quality proxies (no ground truth):** `avg_max_similarity_score`, `chunk_utilization_rate` (cited/retrieved %), `kb_exhaustion_rate` (retrieved < K)
- **Latency analysis:** `rag_overhead_percentage`, `ttfb_impact_of_rag`, `retrieval_latency_p95`
- **Token economics:** `context_overhead_ratio` (added/original), `rag_cost_per_request_avg`, `token_utilization_by_kb`
- **Reliability:** `rag_failure_rate`, `fallback_rate`, `retrieval_timeout_rate`

**Implementation Strategy:**
- Add nullable RAG columns to `traces` table (backward compatible)
- Store similarity scores as JSONB arrays (efficient aggregation, no N+1 queries)
- Pre-compute derived-at-capture-time signals like `rag_overhead_tokens` (avoids joins in analytics queries)
- Token counting via tiktoken (~0.5ms overhead, acceptable)
- Citation parsing via regex on response; defer to trace flush if >2ms

**Observability Without Ground Truth:**
- Chunk utilization rate (% of retrieved chunks cited) as precision proxy
- Similarity score trends detect KB degradation
- Context overhead ratio identifies prompt crowding
- Retrieval latency p95 for SLA monitoring

**Open Questions for Team:**
- Citation format standard (proposed: `[1]`, `[chunk-id]`, or markdown footnotes?)
- Acceptable chunk utilization threshold (proposed: >40%)
- Separate `embedding_traces` table vs embedding data in main traces?
- Fallback policy: automatic graceful degradation vs fail-fast?
- Recommended top-K range (proposed: 3-10, make configurable for A/B testing)

**Handoff to Redfoot:**
- All raw signals are gateway-observable; Redfoot owns aggregation pipeline
- Dashboard panels: utilization rate, cost overhead, latency breakdown by stage
- Alerting thresholds: `rag_failure_rate > 1%`, `chunk_utilization_rate < 30%`
- Time-series for embedding/retrieval latency trends

**What I Learned:**
- RAG observability requires balance: capture enough to diagnose, not so much it bloats traces
- Similarity scores + utilization rate provide quality signal without ground truth labels
- Pre-computing derived metrics at capture time (e.g., `rag_overhead_tokens`) avoids expensive joins
- JSONB arrays for similarity scores beat separate tables (no N+1, native pg aggregation)
- Token counting overhead (~0.5ms) negligible compared to embedding/retrieval latency
- Failure stage isolation critical: distinguish embedding failures from DB timeouts from prompt injection issues
- Cost attribution must separate RAG overhead from base request cost for ROI analysis

**Decision Merged:** 2026-03-01  
Kobayashi's RAG metrics spec merged into `.squad/decisions.md` alongside Redfoot's aggregation strategy. Team now has unified raw/derived signal framework for implementation phasing (P0/P1/P2).

### 2026-03-02: RAG Retrieval at Inference Time

**Context:** Implemented end-to-end RAG pipeline that fires at inference time when an agent has `knowledgeBaseRef` set.

**What Was Built:**
- `src/rag/retrieval.ts`: `retrieveChunks()` (pgvector cosine similarity via knex.raw) and `buildRagContext()` (numbered context block with citation instruction)
- `src/agent.ts`: `injectRagContext()` — async export that resolves KB artifact, embeds query, retrieves chunks, and injects context before the system prompt
- `src/auth.ts`, `src/application/services/TenantService.ts`: `knowledgeBaseRef` threaded through TenantContext from Agent entity
- `src/domain/entities/Agent.ts` + `Agent.schema.ts`: `knowledgeBaseRef` field added
- `src/tracing.ts` + `Trace.ts` + `Trace.schema.ts`: 13 RAG analytics fields wired from TraceInput → BatchRow → INSERT SQL
- `migrations/1000000000016_add-agent-knowledge-base-ref.cjs`: adds `knowledge_base_ref` varchar(255) to agents table

**Key Decisions:**
- `injectRagContext` is called in `index.ts` BEFORE `applyAgentToRequest` so RAG context appears before agent system prompt (merge policy then prepends/appends agent prompt on top)
- Fallback-to-no-RAG on any failure (embedding error, DB error, artifact not found): log the error, set `ragStageFailed` + `fallbackToNoRag: true`, continue normally
- Use system embedder (`embeddingAgentRef: undefined`) by default — EmbeddingAgentService falls back to env vars
- pgvector query uses knex.raw with `?::vector` cast; vector formatted as `[x,y,z,...]` string
- topK hardcoded to 5 default (configurable later via KB spec or agent config)
- Query text extracted from last user message in `messages` array

**What I Learned:**
- `knex.raw('WHERE col <=> ?::vector', [str])` works correctly — knex maps `?` to `$1` before pg receives it; the `::vector` cast is preserved
- TenantContext already flows through the entire request path; adding `knowledgeBaseRef` to it was the minimal change to propagate KB config without changing function signatures
- MikroORM EntitySchema requires all entity fields to have corresponding schema properties — Trace.schema.ts must be kept in sync with Trace.ts even though tracing.ts uses raw SQL
- RAG injection before system prompt merge is the right ordering: `[rag-context] + [agent-system-prompt]` in final system message
