# Redfoot — History

## Core Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**Joined:** 2026-03-01

## Learnings

### 2026-03-01: Analytics Needs for LLM Gateway Operators

Identified six priority areas for Loom analytics expansion:

**P1 - Cost Management:** Multi-dimensional cost attribution (by agent, API key, user metadata, endpoint), cost forecasting, token efficiency metrics. Users need chargeback, budget tracking, and waste identification.

**P2 - Performance & Reliability:** Detailed error breakdowns (by status code, model, provider), latency distributions beyond p95/p99, gateway overhead analysis, streaming vs non-streaming performance comparison.

**P3 - Usage Patterns:** Agent-level analytics (requests, cost, errors per agent), API key usage monitoring, provider/model adoption trends, endpoint usage patterns.

**P4 - Operational Intelligence:** Rate limit tracking (429 errors, near-misses), request/response size analytics, tenant health scorecards (composite metrics), MCP tool routing metrics.

**P5 - Compliance & Security:** Data retention reporting, PII detection, audit log analytics, encryption tracking.

**P6 - Business Intelligence:** Tenant segmentation, cohort retention analysis, feature adoption tracking (streaming, tool calls, vision), revenue analytics for SaaS deployments.

**Key insight:** Different personas need different views. Developers want error diagnostics and latency outliers. Finance wants cost forecasting and attribution. Product wants adoption trends. Admins want health scores and capacity planning. Analytics layer must serve all personas efficiently.

**Implementation strategy:** Leverage existing partition pruning, add composite indexes for common group-bys, consider materialized views for expensive aggregations (daily rollups). Keep dashboard data contracts clean and composable.

### 2025-03-01: Analytics Requirements Analysis
**Context:** Analyzed what analytics Loom users need beyond current minimal coverage (requests, tokens, cost, latency, errors, per-model breakdown).

**Key Categories Identified:**
1. **Platform Operator Needs:** Tenant capacity monitoring, provider economics, system performance SLIs, anomaly detection
2. **Tenant Developer Needs:** Request pattern analysis (endpoint/agent breakdown), cost attribution (per-conversation, prompt efficiency, burn rate), error categorization, trace drill-down
3. **Product/Business Needs:** Adoption metrics (active keys, cohort retention), revenue attribution, margin analysis, usage forecasting

**High-Impact Quick Wins:**
- Endpoint usage breakdown (already have `endpoint` field)
- Agent performance comparison (already have `agent_id`)
- Prompt efficiency ratio (`prompt_tokens / total_tokens`)
- Error categorization by status code
- Latency distribution per model
- Provider reliability scorecard

**Data Gaps Found:**
- No `api_key_id` in traces (can't measure active users/DAU)
- No streaming detection flag (can't compare streaming vs non-streaming TTFB)
- No comprehensive provider pricing table (cost estimates hardcoded for GPT-3.5/4o only)
- No quota/billing tables (blocks budget burn rate, revenue analysis)
- Conversation tracking exists but unclear if `conversation_id` linked to traces

**Architectural Notes:**
- Traces are partitioned by month (good for retention, need to consider cross-partition analytics)
- Already support subtenant rollup via recursive CTE (can extend to tree visualizations)
- Encryption on request/response bodies requires careful access control for trace drill-down feature

**Recommendations Filed:** `.squad/decisions/inbox/redfoot-analytics-recommendations.md`

### 2026-03-01: RAG Analytics Requirements

**Context:** Analyzed analytics needs for Loom's RAG (Retrieval-Augmented Generation) system. RAG adds artifacts (KnowledgeBases), kb_chunks (pgvector), deployments, EmbeddingAgents, and inference-time retrieval to the platform.

**15 RAG-Specific Metrics Identified:**

**Category 1 — Knowledge Base Health:**
- `kb_coverage_ratio` — % of queries with successful chunk retrieval (measures KB completeness)
- `kb_chunk_utilization` — retrieval frequency per chunk (identifies hot/cold content)
- `kb_staleness_days` — time since KB last updated (alerts for outdated content)

**Category 2 — Retrieval Performance:**
- `rag_retrieval_latency_ms` — p50/p95/p99 for embedding + vector search
- `rag_overhead_ratio` — RAG latency as % of total request latency
- `retrieved_chunk_count` — actual chunks returned vs configured topK

**Category 3 — Embedding Operations:**
- `embedding_requests_per_second` — QPS to EmbeddingAgents (query + weave ops)
- `embedding_cost_usd` — per-token costs for embedding operations (OpenAI/Cohere/etc)
- `embedding_error_rate` — provider timeouts/rate limits blocking RAG

**Category 4 — Artifact Lifecycle:**
- `artifact_weave_duration_s` — time to complete chunking + embedding pipeline
- `artifact_size_mb` — bundle sizes for storage planning
- `deployment_status_distribution` — READY/PENDING/FAILED counts

**Category 5 — RAG Quality Signals:**
- `citation_click_rate` — user engagement with source citations (proxy for relevance)
- `rag_relevance_score` — pgvector similarity scores for retrieved chunks
- `zero_shot_fallback_rate` — % queries with zero chunks retrieved

**Key Architectural Decisions:**

1. **Extend Traces:** Add RAG fields to `TraceInput` (`knowledgeBaseId`, `ragRetrievalLatencyMs`, `retrievedChunkCount`, `retrievedChunkIds`, `topChunkSimilarity`). Keeps all request-level signals in one table, leverages existing partitioning.

2. **New Event Tables:** Separate `embedding_operations` and `artifact_operations` tables for non-request events (weave/push/deploy). Allows tracking embedding costs and lifecycle metrics independent of inference traces.

3. **Chunk Utilization Strategy:** Optional `chunk_retrievals` table for granular (trace_id, chunk_id) joins. Alternative: store chunk IDs as JSONB array in traces. Recommended phased approach: start with JSONB, add dedicated table if utilization queries become critical.

4. **Aggregation Layers:**
   - Real-time: last 24h queries on partitioned traces with composite indexes on `(knowledgeBaseId, created_at)`
   - Pre-aggregated: hourly/daily rollup tables for RAG metrics (latency, chunk counts, costs)
   - Hot chunks: daily materialized view of top-100 most-retrieved chunks per KB

5. **Dashboard Placement:**
   - **Operator Dashboard:** New "RAG Analytics" section with latency trends, embedding costs, KB health scorecard
   - **Tenant Portal:** Extend KB detail pages with coverage ratio, hot chunks, relevance scores

**Data Gaps Identified:**
- Embedding provider pricing incomplete (only GPT-3.5/4o in current cost model — need Cohere, Voyage, etc)
- No frontend instrumentation for citation clicks (requires portal event logging)
- No alerting thresholds defined (team decision needed on embedding error rate, zero-shot fallback rate)

**Phasing:**
- **P0 (launch):** Basic RAG fields in traces, embedding_operations table, coverage ratio in portal
- **P1 (2 weeks):** Artifact lifecycle tracking, cost attribution, pre-aggregated rollups
- **P2 (scale):** Chunk-level granularity, citation tracking, advanced quality signals

**Open Questions for Team:**
1. Chunk retrieval granularity (dedicated table vs JSONB array)?
2. Embedding cost model completeness (provider pricing)?
3. Real-time vs 15-min batch tolerance for RAG metrics?
4. Alert thresholds for error rate (5%?), zero-shot fallback (40%?), overhead ratio (30%?)?
5. CLI analytics command (`loom analytics <kb-name>`) needed?

**Recommendations Filed:** `.squad/decisions/inbox/redfoot-rag-analytics.md`

**Decision Merged:** 2026-03-01  
Redfoot's RAG analytics recommendations merged into `.squad/decisions.md` with Kobayashi's raw signal spec. Three-phase implementation plan (P0: MVP, P1: depth, P2: granularity) now documented for team execution. Phasing allows launch without full analytics stack while preserving future extensibility.

### 2026-03-01: RAG Analytics P0 Implementation

**What:** Implemented P0 RAG analytics — extended the analytics pipeline and portal dashboard with RAG performance tiles.

**Files modified:**
- `src/analytics.ts` — added `ragMetrics` computed fields: `ragRequestCount`, `ragFallbackRate`, `avgRetrievalLatencyMs`, `avgChunkSimilarity`, `ragOverheadRatio`; derived from new RAG trace fields
- `src/types.ts` (or analytics types) — extended `SummaryData` type with RAG metric fields
- `portal/src/components/AnalyticsSummary.tsx` — added "RAG Performance" tile group: RAG Requests, Fallback Rate, Avg Retrieval Latency, Avg Chunk Similarity tiles; conditionally rendered when `ragRequestCount > 0`

**Key decisions:**
- P0 tiles are additive and conditionally rendered (zero disruption to tenants without RAG)
- `ragOverheadRatio = ragRetrievalLatencyMs / totalLatencyMs` — pre-computed server-side for clean frontend consumption
- Fallback rate surfaced prominently as a health signal (high fallback = KB or embedder issue)

**Handoff notes for P1:**
- `artifact_operations` table (already in migration) ready for weave/push lifecycle charts
- Pre-aggregated hourly rollups can be added to `analytics.ts` aggregation layer
- KB detail page analytics tab (coverage ratio, hot chunks) deferred to P1
