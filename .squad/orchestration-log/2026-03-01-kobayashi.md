# Orchestration Log — Kobayashi

**Date:** 2026-03-01  
**Agent:** Kobayashi (AI Expert)  
**Task:** RAG-Specific Analytics Metrics Design  
**Status:** Complete

## Spawn Context

- **Role:** Analyze raw signals needed for RAG system observability at gateway layer
- **Input:** Knowledge of Loom architecture, pgvector integration, EmbeddingAgent contract
- **Output:** Comprehensive metrics design document with raw/derived signal definitions

## Deliverable

**Document:** `.squad/decisions/inbox/kobayashi-rag-analytics.md`

### Key Contributions

1. **Raw Signals Framework (6 categories):**
   - Embedding Performance: `embedding_latency_ms`, `embedding_token_count`, `embedding_model`
   - Retrieval Performance: `retrieval_latency_ms`, `chunks_retrieved_count`, `chunks_requested_k`, `retrieval_similarity_scores` (JSONB)
   - Context Injection: `context_tokens_added`, `context_injection_position`, `original_prompt_tokens`
   - Chunk Utilization: `chunks_cited_count`, `chunk_ids_retrieved`
   - Cost Attribution: `rag_overhead_tokens`, `rag_cost_overhead_usd`
   - Failure Modes: `rag_stage_failed`, `fallback_to_no_rag`, `retrieval_timeout_ms`

2. **Derived Signals (for Redfoot):**
   - Quality proxies: `avg_max_similarity_score`, `avg_similarity_variance`, `chunk_utilization_rate`, `kb_exhaustion_rate`
   - Latency analysis: `rag_overhead_percentage`, `ttfb_impact_of_rag`, `retrieval_latency_p95`
   - Token economics: `context_overhead_ratio`, `rag_cost_per_request_avg`, `token_utilization_by_kb`
   - Reliability: `rag_failure_rate`, `fallback_rate`, `retrieval_timeout_rate`

3. **Implementation Notes:**
   - Add nullable RAG columns to `traces` table (backward compatible)
   - Store similarity scores as JSONB arrays (efficient aggregation)
   - Pre-compute `rag_overhead_tokens` at capture time (avoids joins)
   - Token counting via tiktoken (~0.5ms overhead acceptable)
   - Citation parsing deferred to trace flush if >2ms

4. **Open Questions Raised:**
   - Citation format standard (proposed: `[1]`, `[chunk-id]`, markdown footnotes)
   - Acceptable chunk utilization threshold (proposed: >40%)
   - Separate `embedding_traces` table vs embedding data in main traces

## Notes

- Design assumes RAG pipeline: query embedding → pgvector retrieval → context injection → provider inference
- All signals capture-time values; Redfoot handles aggregation and derived metrics
- Strong separation of concerns: raw signals at gateway, derived metrics in analytics layer
