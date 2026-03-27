# Analytics Data Strategy for Scale

**Issue:** [#117](https://github.com/Synaptic-Weave/arachne/issues/117)
**Type:** Research Spike
**Authors:** Architect (Domain Modeling), Dozer (Observability & Analytics)
**Date:** 2026-03-27

---

## 1. Current State Analysis

### What We Have

The analytics system consists of three files that form a simple but functional pipeline:

- **`src/tracing.ts`**: `TraceRecorder` singleton that batches trace writes (100 rows or 5 seconds) via MikroORM's forked EntityManager. Fire-and-forget from the request path.
- **`src/analytics.ts`**: Six raw SQL query functions that aggregate directly against the `traces` table: `getAnalyticsSummary`, `getTimeseriesMetrics`, `getModelBreakdown`, plus admin variants of each. Uses Knex via `src/db.ts`.
- **`src/routes/dashboard.ts` and `src/routes/admin.ts`**: Expose analytics through REST endpoints for tenant-scoped and cross-tenant views.

The `traces` table is already partitioned by month (`PARTITION BY RANGE (created_at)`) with partition names like `traces_2026_03`. It has indexes on `tenant_id`, `request_id`, `created_at`, `model`, and `provider`. The table carries 30+ columns including encrypted request/response bodies, token counts, latency metrics, status codes, and 13 RAG-specific fields.

### What Works Today

- Sub-second analytics for small datasets (thousands of traces)
- Monthly partitioning provides partition pruning on time-range queries
- Subtenant rollup via recursive CTE (`SUBTENANT_CTE`)
- Three analytics views: summary (single-row aggregation), timeseries (time-bucketed), model breakdown (grouped by model)
- Hardcoded cost model for GPT-4o and GPT-3.5; everything else defaults to GPT-4o rates

### What Breaks at Scale

1. **Full table scans for aggregation**: `percentile_cont` requires sorting all matching rows. At 10M+ traces, summary queries will exceed acceptable latency (seconds, not milliseconds).
2. **No pre-aggregation**: Every dashboard load re-computes aggregations from raw rows. Two users viewing the same tenant's summary in the same hour produce identical full scans.
3. **Encrypted bodies bloat the table**: `request_body` and `response_body` (JSONB, encrypted) are stored alongside metrics columns. Even though queries exclude them, the wide row size means fewer rows fit per page, degrading scan performance.
4. **Hardcoded cost model**: The `COST_EXPR` SQL fragment only knows GPT-4o and GPT-3.5 pricing. Adding more providers (Anthropic, Google, Bedrock, Mistral) will require a pricing table.
5. **No per-agent or per-principal breakdowns**: The current queries only group by `model`. Custom Metrics and the Principals feature both need groupable dimensions that don't exist yet.
6. **Subtenant CTE is expensive**: The recursive CTE walks the tenant tree on every rollup query. For deep hierarchies, this adds measurable overhead.
7. **No composite index on `(tenant_id, created_at)`**: The current indexes are single-column. A composite index would enable index-only scans for the most common filter pattern.

---

## 2. Star Schema Design

The star schema separates raw trace storage (write-optimized, wide rows) from analytics (read-optimized, narrow facts with denormalized dimensions).

### Fact Table: `analytics_facts`

One row per trace, containing only the numeric measures and foreign keys to dimension tables. No encrypted bodies, no JSONB.

```sql
analytics_facts (partitioned by RANGE on created_at)
  id                  UUID PRIMARY KEY
  trace_id            UUID NOT NULL           -- FK to traces.id (for drill-through)
  time_id             INTEGER NOT NULL        -- FK to dim_time
  tenant_id           UUID NOT NULL           -- FK to dim_tenant (denormalized)
  agent_id            UUID                    -- FK to dim_agent (nullable)
  model_id            INTEGER NOT NULL        -- FK to dim_model
  provider_id         INTEGER NOT NULL        -- FK to dim_provider
  principal_id        UUID                    -- FK to dim_principal (nullable, future)
  status_code         SMALLINT
  latency_ms          INTEGER
  ttfb_ms             INTEGER
  gateway_overhead_ms INTEGER
  prompt_tokens       INTEGER
  completion_tokens   INTEGER
  total_tokens        INTEGER
  estimated_cost_usd  NUMERIC(10,6)
  -- RAG measures (nullable, only populated for RAG requests)
  rag_retrieval_ms    INTEGER
  embedding_ms        INTEGER
  vector_search_ms    INTEGER
  chunk_count         SMALLINT
  top_similarity      NUMERIC(5,4)
  avg_similarity      NUMERIC(5,4)
  context_tokens      INTEGER
  rag_failed          BOOLEAN DEFAULT FALSE
  rag_fallback        BOOLEAN DEFAULT FALSE
  -- Custom dimensions (future)
  metadata            JSONB
  created_at          TIMESTAMPTZ NOT NULL
```

Partition by `RANGE (created_at)` monthly, mirroring the existing traces partitioning.

### Dimension: `dim_time`

Pre-populated time dimension for fast GROUP BY without date arithmetic.

```sql
dim_time
  id          SERIAL PRIMARY KEY
  ts          TIMESTAMPTZ NOT NULL UNIQUE  -- truncated to hour
  year        SMALLINT
  quarter     SMALLINT
  month       SMALLINT
  day         SMALLINT
  hour        SMALLINT
  day_of_week SMALLINT
  is_weekend  BOOLEAN
```

Pre-populate for the next 3 years (~26,000 rows). Truncate to the hour: all traces within the same hour share one `time_id`. This makes hourly timeseries queries trivial GROUP BYs on an integer FK.

### Dimension: `dim_model`

Slowly changing dimension for model names and pricing.

```sql
dim_model
  id                  SERIAL PRIMARY KEY
  model_name          VARCHAR(255) NOT NULL UNIQUE
  provider_family     VARCHAR(50)           -- 'openai', 'anthropic', 'google', etc.
  input_cost_per_1k   NUMERIC(10,6)         -- $/1K input tokens
  output_cost_per_1k  NUMERIC(10,6)         -- $/1K output tokens
  is_active           BOOLEAN DEFAULT TRUE
  updated_at          TIMESTAMPTZ
```

Replaces the hardcoded `COST_EXPR` in `analytics.ts`. When pricing changes, update the dimension row; historical costs are computed at write time and stored in `analytics_facts.estimated_cost_usd`.

### Dimension: `dim_provider`

```sql
dim_provider
  id              SERIAL PRIMARY KEY
  provider_name   VARCHAR(100) NOT NULL UNIQUE  -- 'openai', 'azure', 'ollama', etc.
  provider_type   VARCHAR(50)                   -- 'cloud', 'self-hosted'
```

### Dimension: `dim_tenant`

Denormalized snapshot of tenant hierarchy for fast rollup queries.

```sql
dim_tenant
  id              UUID PRIMARY KEY         -- same as tenants.id
  tenant_name     VARCHAR(255)
  parent_id       UUID                     -- for tree traversal
  root_tenant_id  UUID                     -- pre-computed root of hierarchy
  depth           SMALLINT                 -- hierarchy depth (0 = root)
  updated_at      TIMESTAMPTZ
```

Pre-computing `root_tenant_id` and `depth` eliminates the recursive CTE for most rollup queries. For a parent tenant wanting to see all subtenant data, query: `WHERE root_tenant_id = :rootId`.

### Dimension: `dim_agent`

```sql
dim_agent
  id              UUID PRIMARY KEY         -- same as agents.id
  agent_name      VARCHAR(255)
  agent_kind      VARCHAR(20)              -- 'inference', 'embedding'
  tenant_id       UUID
  updated_at      TIMESTAMPTZ
```

### Pre-Aggregation Table: `analytics_hourly`

Materialized hourly rollups for the most common dashboard queries.

```sql
analytics_hourly (partitioned by RANGE on hour_ts)
  tenant_id           UUID NOT NULL
  agent_id            UUID             -- nullable; NULL = all agents
  model_id            INTEGER NOT NULL
  hour_ts             TIMESTAMPTZ NOT NULL
  request_count       INTEGER
  error_count         INTEGER
  total_prompt_tokens  BIGINT
  total_compl_tokens   BIGINT
  total_tokens         BIGINT
  total_cost_usd       NUMERIC(12,6)
  sum_latency_ms       BIGINT
  sum_ttfb_ms          BIGINT
  sum_overhead_ms      BIGINT
  min_latency_ms       INTEGER
  max_latency_ms       INTEGER
  -- RAG aggregates
  rag_request_count    INTEGER
  rag_failure_count    INTEGER
  rag_fallback_count   INTEGER
  sum_rag_retrieval_ms BIGINT
  sum_chunk_count      INTEGER
  PRIMARY KEY (tenant_id, model_id, hour_ts, agent_id)
```

Timeseries and summary queries hit this table instead of scanning raw facts. Percentile calculations (p95, p99) still require the raw `analytics_facts` table, but can be limited to the time range and computed on the narrower fact rows.

---

## 3. Technology Recommendation

### Options Considered

| Criterion | PostgreSQL + TimescaleDB | ClickHouse | DuckDB |
|-----------|--------------------------|------------|--------|
| Migration cost | Low (PG extension, same connection) | High (new service, new query language) | Medium (embedded, no multi-process) |
| Operational burden | Minimal (same PG instance) | Significant (separate cluster) | Low (embedded, no HA) |
| Query performance (OLAP) | Good (columnar via compression) | Excellent (purpose-built OLAP) | Good (columnar, single-node) |
| Real-time ingestion | Native (same PG) | Good (async inserts) | Poor (batch-oriented) |
| Multi-tenant isolation | Native (row-level, same as today) | Requires application-level | Application-level |
| pgvector compatibility | Full (same database) | None | None |
| Continuous aggregates | Built-in (auto-refreshing materialized views) | Materialized views (manual) | No built-in |
| Horizontal scaling | TimescaleDB multi-node (future) | Native sharding | Single-node only |
| Team expertise needed | PostgreSQL (existing) | ClickHouse SQL dialect | Minimal |
| Cost (hosted) | Timescale Cloud or self-hosted PG | ClickHouse Cloud ($$$) | Free (embedded) |

### Recommendation: PostgreSQL with TimescaleDB Extension

**Rationale:**

1. **Zero infrastructure change**: TimescaleDB is a PostgreSQL extension. `CREATE EXTENSION timescaledb;` on the existing database. No new service to deploy, monitor, or secure.
2. **Continuous aggregates**: TimescaleDB's continuous aggregates automatically maintain the `analytics_hourly` rollup table. Define the aggregate query once; TimescaleDB incrementally updates it as new data arrives. This replaces a custom ETL pipeline.
3. **Hypertable compression**: After 7 days, compress chunks to columnar format. Reduces storage 90%+ and speeds up analytical scans.
4. **Partition management**: TimescaleDB auto-creates time partitions (chunks). Replaces the manual partition creation in migration `1000000000003`.
5. **Same connection string**: Analytics queries use the same `DATABASE_URL`. No cross-database joins or data synchronization needed.
6. **Startup-appropriate**: No additional infrastructure, no additional hosting costs (beyond slightly more CPU for compression), no new operational runbooks.

**When to reconsider ClickHouse**: If trace volume exceeds 100M rows/month and query latency on the pre-aggregated tables exceeds SLOs. At that scale, Arachne would be in a position to justify the operational overhead of a dedicated OLAP system.

**DuckDB verdict**: Good for embedded analytics or local development tooling. Not appropriate for a multi-tenant production gateway (single-process, no concurrent write support).

---

## 4. ETL Pipeline Design

With TimescaleDB, the ETL is internal to PostgreSQL. No external pipeline needed.

### Write Path (modified TraceRecorder)

```
TraceRecorder.flush()
  |
  v
1. Persist Trace entities to `traces` table (existing behavior, unchanged)
  |
  v
2. For each trace in the batch, INSERT into `analytics_facts`
   - Look up (or auto-create) dim_model row by model name
   - Look up dim_time row by TRUNCATE(created_at, 'hour')
   - Compute estimated_cost_usd using dim_model pricing
   - Copy numeric fields only (no encrypted bodies)
  |
  v
3. TimescaleDB continuous aggregate auto-updates `analytics_hourly`
```

The dual-write happens in the same `flush()` call, within the same transaction. If the analytics insert fails, the trace still persists (the analytics insert should be in a separate try/catch to avoid blocking trace persistence).

### Dimension Sync

- **`dim_tenant`**: Sync on tenant create/update. `TenantManagementService` upserts `dim_tenant` with pre-computed `root_tenant_id` and `depth`.
- **`dim_agent`**: Sync on agent create/update via portal routes.
- **`dim_model`**: Auto-created on first occurrence. Admin UI provides a pricing management page.
- **`dim_provider`**: Seeded at startup; auto-created on first occurrence.
- **`dim_time`**: Pre-populated via migration for 3 years of hourly buckets.

---

## 5. Migration Strategy

### Phase A: Schema + Backfill (non-breaking)

1. `CREATE EXTENSION IF NOT EXISTS timescaledb;`
2. Create dimension tables (`dim_time`, `dim_model`, `dim_provider`, `dim_tenant`, `dim_agent`)
3. Create `analytics_facts` as a TimescaleDB hypertable with monthly chunks
4. Create continuous aggregate `analytics_hourly` over `analytics_facts`
5. Pre-populate `dim_time` (3 years of hourly buckets)
6. Seed dimension tables from existing `tenants`, `agents` data
7. Backfill script: one-time batch job that reads existing `traces` rows and populates `analytics_facts`. Process in batches of 10,000 rows.

During this phase, existing analytics queries continue to read from `traces`. No user-facing changes.

### Phase B: Dual-Write (transition)

1. Modify `TraceRecorder.flush()` to dual-write: persist to `traces` and insert into `analytics_facts`
2. Add dimension sync hooks to tenant and agent CRUD operations
3. Validate: run both old and new analytics queries in parallel, compare results
4. Add a composite index `(tenant_id, created_at)` on `analytics_facts`

During this phase, dashboard endpoints still read from the old `traces`-based queries. The new analytics tables are being populated and validated.

### Phase C: Query Cutover

1. Create new analytics query module (`src/analytics-v2.ts`) that queries `analytics_hourly` for timeseries and summary, `analytics_facts` for percentiles and drill-through
2. Feature-flag the cutover: `ANALYTICS_V2=true` switches `DashboardService` and portal routes to use v2 queries
3. Monitor query latency and result accuracy for 1-2 weeks
4. Remove feature flag; delete old analytics queries

### Phase D: Cleanup and Optimization

1. Enable TimescaleDB compression on chunks older than 7 days
2. Add retention policy: drop chunks older than 90 days (configurable per tenant tier)
3. Remove duplicate columns from `traces` that are now in `analytics_facts` (optional; `traces` may still need them for trace detail view)
4. Convert manual partition management code to use TimescaleDB's automatic chunk management

---

## 6. Query Pattern Catalog

### Current Patterns (mapped to new schema)

| Query | Current Source | New Source | Improvement |
|-------|---------------|------------|-------------|
| Summary: total requests, tokens, cost, avg latency, error rate | Full scan of `traces` with `COALESCE/SUM/AVG` | `SUM` over `analytics_hourly` rows | Orders of magnitude faster (pre-aggregated) |
| Summary: p95/p99 latency | `percentile_cont` over all matching `traces` | `percentile_cont` over `analytics_facts` (narrow rows) | 3-5x faster due to narrower rows |
| Timeseries: hourly buckets | `floor(extract(epoch...))` group-by on `traces` | Direct read from `analytics_hourly` | Pre-computed; O(hours) not O(traces) |
| Model breakdown | `GROUP BY model` on `traces` | `GROUP BY model_id` on `analytics_hourly` with join to `dim_model` | Pre-aggregated |
| Subtenant rollup | Recursive CTE + filter on `traces` | `WHERE root_tenant_id = :id` on `dim_tenant` join | Eliminates recursive CTE |

### Future Patterns (enabled by new schema)

| Query | Source | Notes |
|-------|--------|-------|
| Per-agent breakdown | `GROUP BY agent_id` on `analytics_hourly` | Not possible today (no agent_id in queries) |
| Per-principal breakdown | `GROUP BY principal_id` on `analytics_facts` | Requires principal tracking (in progress) |
| Custom dimension filtering | `WHERE metadata @> '...'` on `analytics_facts` | Extensible via JSONB metadata field |
| Cost breakdown by provider | `GROUP BY provider_id` join `dim_provider` on `analytics_hourly` | Enables cost-optimized routing insights |
| Latency heatmap (hour x day-of-week) | `GROUP BY hour, day_of_week` join `dim_time` | Visual dashboard feature |
| A/B variant comparison | `WHERE metadata->>'variant' = 'B'` on `analytics_facts` | Web Weaver integration |
| SLO burn rate | Compare `analytics_hourly` aggregates against SLO thresholds | Alerting feature |
| Conversation analytics | Join `analytics_facts` with conversation tables | Cross-feature analytics |

---

## 7. Cost and Complexity Assessment

| Item | Effort | Risk | Notes |
|------|--------|------|-------|
| TimescaleDB extension install | 1 hour | Low | Single SQL command; supported by all managed PG providers |
| Dimension table migrations | 1-2 days | Low | Standard DDL; well-understood pattern |
| Backfill script | 1 day | Medium | Must handle large datasets; run during low traffic |
| TraceRecorder dual-write | 1-2 days | Medium | Must not break existing trace persistence; needs error isolation |
| Dimension sync hooks | 1 day | Low | Simple upserts on existing CRUD paths |
| analytics-v2.ts query module | 2-3 days | Low | Simpler queries against pre-aggregated data |
| Continuous aggregate definition | 0.5 days | Low | Single SQL statement; TimescaleDB handles refresh |
| Feature flag + cutover | 1 day | Low | Standard feature flag pattern |
| Compression policy | 0.5 days | Low | Single TimescaleDB API call |
| **Total estimated effort** | **8-12 days** | | Across 2-3 iterations |

### Operational Burden (ongoing)

- TimescaleDB compression runs automatically on a background worker
- Continuous aggregates refresh automatically (configurable lag, default: 1 hour)
- Dimension tables are append-mostly; no maintenance needed
- Chunk retention policies run automatically

### Storage Savings Estimate

- Current `traces` table: ~2KB per row (including encrypted JSONB bodies)
- `analytics_facts` row: ~200 bytes (numeric columns only)
- With TimescaleDB compression (after 7 days): ~20 bytes per row effective
- Net: 100x storage reduction for analytics workload
