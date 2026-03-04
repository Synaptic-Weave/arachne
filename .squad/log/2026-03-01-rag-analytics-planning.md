# 2026-03-01: RAG Analytics Planning Session

**Date:** 2026-03-01  
**Participants:** Kobayashi (AI Expert), Redfoot (Data Engineer), Keaton (Lead), Coordinator  
**Topic:** Knowledge Base RAG System Observability and Analytics Design  
**Status:** Complete

---

## Session Summary

Kobayashi and Redfoot designed comprehensive RAG analytics for Loom gateway layer. Goal: Provide operators and tenants visibility into RAG system health, performance, cost, and quality.

### Raw Signals Architecture (Kobayashi)

Defined 6 categories of raw signals captured at gateway layer per-request:

1. **Embedding Metrics:** latency, token count, model choice
2. **Retrieval Metrics:** pgvector latency, chunk counts, similarity scores (JSONB)
3. **Context Injection:** tokens added, injection position, original prompt baseline
4. **Chunk Utilization:** citation counts (parsed from response), chunk IDs
5. **Cost Attribution:** RAG overhead tokens, USD cost (pre-computed)
6. **Failure Modes:** stage where failure occurred, fallback flags, timeout values

**Storage:** Nullable columns in `traces` table (backward compatible). Similarity scores as JSONB arrays (avoids N+1 queries on aggregation).

### Derived Metrics Strategy (Redfoot)

Proposed 15 derived metrics computed via aggregation queries (NOT stored in traces):

- **KB Health:** coverage ratio, chunk utilization distribution, staleness tracking
- **Retrieval Performance:** latency percentiles (p50/p95/p99), overhead ratio, chunk distribution
- **Embedding Operations:** QPS by agent, cost attribution, error rate monitoring
- **Artifact Lifecycle:** weave duration, bundle size, deployment status health
- **Quality Signals:** citation click-through (requires frontend), relevance scores, zero-shot fallback rate

**Computation Strategy:** Real-time dashboard queries for 24h windows (partition pruning). Pre-aggregated hourly/daily rollups for scale. Materialized "hot chunks" summary table.

### Dashboard Design

**Operator Dashboard (McManus):**
- New "RAG Analytics" section alongside Tenants/Analytics
- Tiles: RAG requests, overhead ratio, embedding cost, fallback rate
- Charts: latency trends (p50/p95/p99), KB coverage, embedding QPS, deployment status
- Tables: top KBs by volume, slowest retrievals, recent failures

**Tenant Portal:**
- KB detail page → new "Analytics" tab showing coverage, similarity trends, hot chunks
- Agent pages → RAG latency breakdown for knowledge-base-enabled agents
- New "RAG Performance" dedicated page for per-KB trends and cost attribution

### Implementation Phases

**P0 (Launch):** Extend traces with RAG fields, `embedding_operations` table, basic operator tiles
**P1 (2 weeks):** Artifact lifecycle tracking, overhead/cost metrics, hourly rollups, KB detail analytics
**P2 (Scale):** Granular chunk retrieval tracking, citation instrumentation, advanced quality signals

### Open Questions Raised

1. **Citation Format:** Standardize on `[1]`, `[chunk-id]`, or markdown footnotes?
2. **Chunk Utilization Threshold:** Acceptable rate? (Proposed: >40%)
3. **Retrieval Granularity:** Store all `(trace_id, chunk_id)` pairs or use JSONB in traces?
4. **Embedding Cost Expansion:** Need provider pricing for Cohere, Voyage, etc (currently GPT-3.5/4o only)
5. **Alert Thresholds:** Embedding error >5%? Fallback >40%? Overhead >30%?

### Decisions Merged

✅ Merged both inbox files into `.squad/decisions.md`  
✅ Recorded orchestration logs for both agents  
✅ Appended learnings to agent history files  
✅ Created git commit with RAG analytics planning summary

### Success Criteria

- Operators can identify underperforming KBs within 30 seconds (dashboard scan)
- Tenant developers can debug RAG latency via trace drill-down
- Finance teams can attribute embedding costs per tenant/KB
- Product teams can measure KB adoption and request patterns
- Platform SRE can detect embedding provider degradation via alerts

---

## Next Steps (for Keaton)

1. **GitHub Stories:** Create/update issues #64-#67 with implementations for P0 metrics
2. **Trace Schema:** PR to add RAG columns (nullable)
3. **Embedding Operations Table:** Migration + instrumentation in gateway
4. **Dashboard Tiles:** Operator dashboard MVP (4 basic metrics)
5. **KB Analytics Tab:** Tenant portal analytics page (coverage, trends)

---

## References

- Kobayashi Document: `.squad/decisions/inbox/kobayashi-rag-analytics.md`
- Redfoot Document: `.squad/decisions/inbox/redfoot-rag-analytics.md`
- Keaton's Backlog: GitHub stories #64-#67 (pending #68)
