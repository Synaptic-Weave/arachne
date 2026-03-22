# Observability Architecture

> Tracked by Epic [#161](https://github.com/Synaptic-Weave/arachne/issues/161)

**Status:** Draft
**Author:** Arachne Team
**Last Updated:** 2026-03-16

## 1. Overview

Arachne's observability architecture replaces the current synchronous, in-process trace recording pipeline with an event-driven system built on three pillars:

1. **Structured lifecycle events** emitted from the gateway hot path via a queue-agnostic `EventBus` interface.
2. **Asynchronous worker processes** that consume events, encrypt sensitive payloads, and write to both TimescaleDB (time-series analytics) and PostgreSQL (composite Trace rows for tenant dashboards).
3. **Two-tier caching** (in-process L1 + Redis L2) with pub/sub invalidation across gateway replicas.

The architecture preserves the current < 20ms gateway overhead target by moving all write-path work (encryption, persistence, aggregation) off the request thread. It supports a single-binary "desktop mode" for local development and solo deployments, where all components run in-process against SQLite.

---

## 2. Architecture Diagram

```
                          Tenant App / CLI
                               |
                     POST /v1/chat/completions
                               |
                               v
               +-------------------------------+
               |        Gateway Process        |
               |  (Fastify + EventBus.emit())  |
               |                               |
               |  L1 Cache (Map, 30s TTL)      |
               +---------|---------------------+
                         |           |
               emit()    |           | get/set
                         v           v
               +---------+   +-------------+
               |  Queue   |   |    Redis    |
               | (agnostic|   | L2 Cache +  |
               |  adapter)|   | pub/sub     |
               +---------+   +-------------+
                    |                |
                    v                | invalidation
          +------------------+      | broadcast
          |  Worker Process  |<-----+
          |  (src/worker.ts) |
          |                  |
          |  - Decrypt/Encrypt
          |  - Assemble Trace
          |  - Write points
          +--------+---------+
                   |
          +--------+---------+
          |                  |
          v                  v
  +---------------+  +---------------+
  | TimescaleDB   |  | PostgreSQL    |
  | (hypertable:  |  | (traces table |
  |  events,      |  |  for tenant   |
  |  continuous   |  |  dashboards)  |
  |  aggregates)  |  |               |
  +-------+-------+  +-------+-------+
          |                  |
          v                  v
  +---------------+  +---------------+
  |   Grafana     |  |  Recharts     |
  | (operator     |  | (tenant       |
  |  dashboards)  |  |  dashboards)  |
  +---------------+  +---------------+
```

**Desktop mode** collapses this to a single process: `InMemoryEventBus` replaces the queue, the worker logic runs inline, and SQLite replaces both TimescaleDB and PostgreSQL.

---

## 3. Request Envelope

Every event emitted during a request carries a correlation envelope that links it to the originating request, tenant, and agent.

```typescript
/**
 * Correlation context attached to every GatewayEvent.
 * The worker uses these fields to group events into composite Trace rows
 * and to route data to the correct tenant partition.
 */
interface RequestEnvelope {
  /** UUIDv4 generated at request entry. Correlates all events for one request. */
  requestId: string;

  /** Tenant resolved from the API key. Present on all events after auth. */
  tenantId: string;

  /** Agent bound to the API key, if any. */
  agentId?: string;

  /** End-user identity from X-Arachne-Principal header. */
  principalId?: string;

  /** Deployment slot ID, if the request targets a deployment. */
  deploymentId?: string;

  /** Unix epoch ms when the gateway received the request. */
  timestamp: number;
}
```

The `requestId` is generated once in the request handler and threaded through all downstream calls. It is returned to the caller via the `X-Arachne-Request-ID` response header for client-side correlation.

---

## 4. Event Taxonomy

Events are organized into categories. Each event has a **visibility** classification:

- **Internal**: Operator-only (Grafana dashboards, debugging).
- **Tenant-visible**: Exposed in tenant analytics and Recharts dashboards.
- **Both**: Available to operators and tenants.

### 4.1 Request Lifecycle

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `request.received` | Both | Gateway receives the HTTP request | `method`, `path`, `model`, `stream` | Request rate metrics, start of latency measurement |
| `request.completed` | Both | Response fully sent to client | `statusCode`, `latencyMs`, `ttfbMs`, `gatewayOverheadMs` | End-to-end latency, overhead tracking |
| `request.failed` | Both | Unhandled error in the request pipeline | `error`, `statusCode` | Error rate, error classification |

### 4.2 Authentication

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `auth.resolved` | Internal | API key successfully resolved to TenantContext | `cacheHit`, `resolutionMs` | Cache hit ratio, auth latency |
| `auth.failed` | Internal | API key missing, invalid, or tenant inactive | `reason`, `keyHashPrefix` | Security alerting, brute-force detection |

### 4.3 Conversation Memory

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `conversation.resolved` | Tenant-visible | Conversation found or created | `conversationId`, `isNew`, `partitionId` | Conversation lifecycle tracking |
| `conversation.context_loaded` | Internal | History + snapshots loaded from DB | `messageCount`, `tokenEstimate`, `snapshotId`, `loadMs` | Memory subsystem health |
| `conversation.summarized` | Tenant-visible | Token budget exceeded, summary generated | `originalTokens`, `summaryTokens`, `summaryModel`, `summarizeMs` | Summary frequency, token savings |

### 4.4 RAG Retrieval

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `rag.started` | Both | RAG pipeline begins for a request | `knowledgeBaseId` | RAG usage tracking |
| `rag.embedding.completed` | Internal | Query embedding generated | `embeddingMs`, `embeddingModel` | Embedding latency monitoring |
| `rag.search.completed` | Internal | Vector search returns chunks | `vectorSearchMs`, `chunkCount`, `topSimilarity`, `avgSimilarity` | Retrieval quality metrics |
| `rag.injection.completed` | Both | Chunks injected into prompt | `contextTokensAdded`, `ragOverheadTokens` | Token overhead from RAG |
| `rag.failed` | Both | Any RAG stage failed | `stage`, `error`, `fallbackToNoRag` | RAG reliability, fallback rate |

### 4.5 Agent Application

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `agent.config_applied` | Internal | System prompt and skills merged into request | `mergePolicy`, `skillCount`, `mcpEndpointCount` | Agent config audit trail |

### 4.6 Provider Proxy

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `provider.request.sent` | Internal | Upstream fetch initiated | `provider`, `model`, `baseUrl` | Provider routing audit |
| `provider.response.completed` | Both | Upstream response fully received | `statusCode`, `upstreamLatencyMs`, `promptTokens`, `completionTokens`, `totalTokens`, `estimatedCostUsd` | Provider latency, token usage, cost tracking |
| `provider.response.error` | Both | Upstream returned >= 400 | `statusCode`, `errorCode`, `errorMessage`, `provider` | Provider error rate, error classification |

### 4.7 Streaming

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `stream.first_byte` | Both | First SSE chunk forwarded to client | `ttfbMs` | Time-to-first-byte tracking |
| `stream.completed` | Internal | SSE stream ends, `[DONE]` received | `totalChunks`, `contentLength`, `streamDurationMs` | Stream health monitoring |

### 4.8 MCP Tool Execution

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `mcp.round_trip.started` | Both | Tool calls detected in provider response | `toolCallCount` | MCP usage tracking |
| `mcp.tool.called` | Both | Individual MCP endpoint invoked | `toolName`, `endpointUrl`, `callMs`, `statusCode` | Per-tool latency and error tracking |
| `mcp.round_trip.completed` | Both | All tool results sent back to provider | `totalMs`, `toolCallCount` | Round-trip overhead |

### 4.9 Cache Operations

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `cache.hit` | Internal | L1 or L2 cache returns a value | `namespace`, `layer` (`l1` or `l2`), `key` | Cache hit ratio per layer |
| `cache.miss` | Internal | Both L1 and L2 miss, falling through to DB | `namespace`, `key`, `loadMs` | Cache miss rate, cold-start impact |
| `cache.eviction` | Internal | Entry evicted from L1 or L2 | `namespace`, `layer`, `reason` (`ttl`, `capacity`, `invalidation`) | Cache pressure monitoring |

### 4.10 Gateway Health

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `gateway.queue.depth` | Internal | Periodic (every 10s) | `depth`, `oldestEventAge` | Queue backpressure alerting |
| `gateway.process.stats` | Internal | Periodic (every 30s) | `heapUsedMb`, `rss`, `eventLoopDelayMs`, `activeRequests` | Process health, memory leak detection |

### 4.11 Agent Messaging

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `agent.message_sent` | Both | Agent sends a message via bus | `sourceAgentId`, `targetAgentId`, `channel`, `correlationId`, `contentLength` | Inter-agent communication tracking |
| `agent.message_received` | Both | Agent receives and processes a message | `targetAgentId`, `sourceAgentId`, `channel`, `correlationId`, `processingMs` | Message delivery latency |
| `agent.message_failed` | Both | Message delivery or processing failed | `sourceAgentId`, `targetAgentId`, `error` | Messaging reliability |

### 4.12 Channel Operations

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `channel.created` | Internal | New channel created | `channelName`, `pattern`, `createdBy` | Channel lifecycle tracking |
| `channel.subscribed` | Internal | Agent subscribes to channel | `channelName`, `agentId` | Subscription tracking |
| `channel.unsubscribed` | Internal | Agent unsubscribes | `channelName`, `agentId` | Subscription tracking |
| `channel.message_published` | Internal | Message published to channel | `channelName`, `subscriberCount`, `sourceAgentId` | Channel throughput |

### 4.13 Schedule Execution

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `schedule.triggered` | Both | Cron fires for a schedule | `scheduleId`, `agentId`, `cron`, `mode` | Schedule activity tracking |
| `schedule.completed` | Both | Scheduled execution finished successfully | `scheduleId`, `agentId`, `executionMs`, `mode` | Schedule performance |
| `schedule.failed` | Both | Scheduled execution failed | `scheduleId`, `agentId`, `error`, `retryCount` | Schedule reliability |
| `schedule.skipped` | Internal | Execution skipped (previous still running) | `scheduleId`, `reason` | Concurrency monitoring |

### 4.14 Team Orchestration

| Event | Visibility | Fires When | Key Fields | Enables |
|-------|-----------|------------|------------|---------|
| `team.execution_started` | Both | AgentTeam begins processing a request | `teamId`, `pattern`, `memberCount` | Team usage tracking |
| `team.task_assigned` | Both | Coordinator assigns work to a member agent | `teamId`, `agentId`, `taskType` | Orchestration flow tracking |
| `team.task_completed` | Both | Member agent completes assigned work | `teamId`, `agentId`, `taskType`, `durationMs` | Per-agent performance within teams |
| `team.execution_completed` | Both | AgentTeam finishes, returning final response | `teamId`, `pattern`, `totalMs`, `stepsExecuted` | End-to-end team latency |
| `team.execution_failed` | Both | Team execution failed | `teamId`, `error`, `failedAgentId` | Team reliability |

---

## 5. EventBus Interface

The `EventBus` is the core abstraction that decouples event producers (gateway) from consumers (worker). Implementations must be swappable without changing application code.

### 5.1 Core Types

```typescript
/** Base event shape. All lifecycle events extend this. */
interface GatewayEvent {
  /** Event type from the taxonomy (e.g. 'request.received'). */
  type: string;

  /** Correlation ID linking all events for one request. */
  requestId: string;

  /** Tenant that owns this request. Absent only for pre-auth events. */
  tenantId?: string;

  /** Unix epoch ms when the event was created. */
  timestamp: number;

  /** Arbitrary payload fields specific to the event type. */
  [key: string]: unknown;
}

/** Consumer callback signature. */
type EventHandler = (event: GatewayEvent) => Promise<void> | void;

/** Queue-agnostic event bus contract. */
interface EventBus {
  /**
   * Emit an event. In production this publishes to the message queue.
   * In desktop mode it dispatches to in-process handlers.
   * Must never throw — failures are logged and swallowed.
   */
  emit(event: GatewayEvent): void;

  /**
   * Register a handler for one or more event types.
   * Used by the worker process to subscribe to events.
   * Supports glob patterns: 'rag.*' matches all RAG events.
   */
  on(pattern: string, handler: EventHandler): void;

  /**
   * Graceful shutdown: flush pending events, close connections.
   */
  shutdown(): Promise<void>;
}
```

### 5.2 Production Implementation (Queue-backed)

```typescript
/**
 * Publishes events to an external message queue.
 * The queue technology is injected via QueueAdapter, keeping
 * the EventBus itself queue-agnostic.
 */
class QueueEventBus implements EventBus {
  private adapter: QueueAdapter;
  private buffer: GatewayEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(adapter: QueueAdapter) {
    this.adapter = adapter;
    // Micro-batch: flush every 50ms or 50 events to reduce per-event overhead.
    this.flushTimer = setInterval(() => this.flush(), 50);
    this.flushTimer.unref();
  }

  emit(event: GatewayEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= 50) {
      void this.flush();
    }
  }

  on(pattern: string, handler: EventHandler): void {
    this.adapter.subscribe(pattern, handler);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      await this.adapter.publishBatch(batch);
    } catch (err) {
      console.error('[eventbus] flush failed:', err);
      // Events are lost — acceptable for observability data.
      // A dead-letter mechanism in the adapter can reduce loss.
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
    await this.adapter.close();
  }
}
```

### 5.3 Queue Adapter Contract

```typescript
/**
 * Thin adapter over the actual queue technology.
 * Swap this to switch from one queue to another.
 */
interface QueueAdapter {
  publishBatch(events: GatewayEvent[]): Promise<void>;
  subscribe(pattern: string, handler: EventHandler): void;
  close(): Promise<void>;
}
```

### 5.4 Usage in the Request Handler

```typescript
// src/index.ts — simplified excerpt showing EventBus integration

const eventBus: EventBus = createEventBus(); // factory resolves impl from config

fastify.post('/v1/chat/completions', async (request, reply) => {
  const requestId = randomUUID();
  const startMs = Date.now();

  eventBus.emit({
    type: 'request.received',
    requestId,
    tenantId: request.tenant?.tenantId,
    timestamp: startMs,
    model: (request.body as any)?.model,
    stream: (request.body as any)?.stream ?? false,
  });

  // ... auth, conversation, RAG, agent application ...
  // Each subsystem emits its own events using the same requestId.

  const upstreamStartMs = Date.now();
  eventBus.emit({
    type: 'provider.request.sent',
    requestId,
    tenantId: request.tenant!.tenantId,
    timestamp: upstreamStartMs,
    provider: provider.name,
    model: effectiveBody.model,
  });

  const response = await provider.proxy(proxyReq);

  eventBus.emit({
    type: 'provider.response.completed',
    requestId,
    tenantId: request.tenant!.tenantId,
    timestamp: Date.now(),
    statusCode: response.status,
    upstreamLatencyMs: Date.now() - upstreamStartMs,
    promptTokens: response.body?.usage?.prompt_tokens,
    completionTokens: response.body?.usage?.completion_tokens,
    totalTokens: response.body?.usage?.total_tokens,
  });

  // ... send response ...

  eventBus.emit({
    type: 'request.completed',
    requestId,
    tenantId: request.tenant!.tenantId,
    timestamp: Date.now(),
    statusCode: response.status,
    latencyMs: Date.now() - startMs,
    gatewayOverheadMs: upstreamStartMs - startMs,
  });
});
```

---

## 6. Worker Container

### 6.1 Architecture

The worker runs from the same codebase as the gateway but with a different entrypoint (`src/worker.ts`). It shares domain entities, encryption utilities, and TypeScript types. It does not run Fastify or serve HTTP traffic.

```
src/
├── worker.ts              # Entrypoint: connect to queue, register handlers
├── worker/
│   ├── TraceAssembler.ts  # Groups events by requestId, builds Trace entity
│   ├── TimeSeriesWriter.ts # Writes individual event points to TimescaleDB
│   └── HealthReporter.ts  # Emits gateway.queue.depth and process stats
```

### 6.2 Responsibilities

1. **Consume events** from the message queue via the `QueueAdapter.subscribe()` interface.
2. **Encrypt sensitive payloads** — request/response bodies are encrypted with per-tenant AES-256-GCM keys, moved off the gateway hot path.
3. **Assemble composite Traces** — the `TraceAssembler` collects events for a `requestId` with a 30-second window, then writes a single `Trace` row to PostgreSQL (preserving backward compatibility with existing tenant dashboards).
4. **Write time-series points** — each event is independently written to the TimescaleDB `gateway_events` hypertable for fine-grained operator analytics.
5. **Cost estimation** — the worker computes `estimated_cost_usd` from token counts and model pricing, replacing the inline SQL CASE expression.

### 6.3 Trace Assembly

```typescript
class TraceAssembler {
  // In-memory map of requestId -> collected events.
  // Entries are flushed after 30s or when request.completed is received.
  private pending = new Map<string, { events: GatewayEvent[]; timer: NodeJS.Timeout }>();

  onEvent(event: GatewayEvent): void {
    const entry = this.pending.get(event.requestId) ?? this.createEntry(event.requestId);
    entry.events.push(event);

    if (event.type === 'request.completed' || event.type === 'request.failed') {
      this.assemble(event.requestId);
    }
  }

  private assemble(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    const events = entry.events;
    const received = events.find(e => e.type === 'request.received');
    const completed = events.find(e => e.type === 'request.completed');
    const providerResp = events.find(e => e.type === 'provider.response.completed');

    // Build Trace entity from composed fields...
    // Encrypt request/response bodies using per-tenant key...
    // Persist to PostgreSQL traces table...
  }
}
```

### 6.4 Scaling

Workers scale independently of gateway replicas. Each worker instance joins the same consumer group, so the queue distributes events across workers. No coordination is needed between workers because events for the same `requestId` are routed to the same partition (using `requestId` as the partition key, or `tenantId` for tenant-level ordering).

### 6.5 Startup

```bash
# Production: gateway and worker as separate processes
npm run start:gateway    # src/index.ts
npm run start:worker     # src/worker.ts

# Development: single process (desktop mode, see Section 10)
npm run dev              # runs both inline
```

---

## 7. TimescaleDB Integration

### 7.1 Rationale

The current `traces` table uses manual monthly partitions (`traces_YYYY_MM`) and hand-rolled epoch-floor bucketing in `analytics.ts`. TimescaleDB provides:

- Automatic time-based partitioning via hypertables (replaces manual `Partition` entity management).
- Native `time_bucket()` function (replaces `to_timestamp(floor(extract(epoch from created_at) / seconds) * seconds)`).
- Continuous aggregates with automatic refresh (replaces on-the-fly aggregation queries).
- Built-in compression and retention policies.

### 7.2 Hypertable: `gateway_events`

This is the new fine-grained event store, written to by the `TimeSeriesWriter`.

```sql
-- Migration: create gateway_events hypertable
CREATE TABLE gateway_events (
  time          TIMESTAMPTZ    NOT NULL,
  request_id    UUID           NOT NULL,
  tenant_id     UUID           NOT NULL,
  agent_id      UUID,
  principal_id  VARCHAR(255),
  deployment_id UUID,
  event_type    VARCHAR(64)    NOT NULL,
  payload       JSONB          NOT NULL DEFAULT '{}'
);

-- Convert to hypertable with 1-hour chunks
SELECT create_hypertable('gateway_events', 'time',
  chunk_time_interval => INTERVAL '1 hour'
);

-- Indexes for common query patterns
CREATE INDEX idx_events_tenant_time ON gateway_events (tenant_id, time DESC);
CREATE INDEX idx_events_request_id  ON gateway_events (request_id);
CREATE INDEX idx_events_type_time   ON gateway_events (event_type, time DESC);
```

### 7.3 Continuous Aggregates

Replace the per-query aggregations in `analytics.ts` with pre-computed rollups.

#### Hourly Request Metrics

```sql
CREATE MATERIALIZED VIEW hourly_request_metrics
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time)                           AS bucket,
  tenant_id,
  (payload->>'model')::text                             AS model,
  (payload->>'provider')::text                          AS provider,
  COUNT(*)                                              AS request_count,
  AVG((payload->>'latencyMs')::float)                   AS avg_latency_ms,
  percentile_agg((payload->>'latencyMs')::double precision) AS latency_pct,
  SUM((payload->>'totalTokens')::bigint)                AS total_tokens,
  SUM((payload->>'promptTokens')::bigint)               AS prompt_tokens,
  SUM((payload->>'completionTokens')::bigint)           AS completion_tokens,
  SUM((payload->>'estimatedCostUsd')::numeric)          AS estimated_cost_usd,
  COUNT(*) FILTER (
    WHERE (payload->>'statusCode')::int >= 400
  )                                                     AS error_count,
  AVG((payload->>'gatewayOverheadMs')::float)           AS avg_overhead_ms,
  AVG((payload->>'ttfbMs')::float)                      AS avg_ttfb_ms
FROM gateway_events
WHERE event_type = 'request.completed'
GROUP BY bucket, tenant_id, model, provider
WITH NO DATA;

-- Refresh policy: update every 10 minutes, covering last 2 hours
SELECT add_continuous_aggregate_policy('hourly_request_metrics',
  start_offset    => INTERVAL '2 hours',
  end_offset      => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '10 minutes'
);
```

#### Daily Rollup

```sql
CREATE MATERIALIZED VIEW daily_request_metrics
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', bucket)    AS bucket,
  tenant_id,
  model,
  provider,
  SUM(request_count)              AS request_count,
  -- Re-aggregate from hourly; weighted average for latency
  SUM(avg_latency_ms * request_count) / NULLIF(SUM(request_count), 0) AS avg_latency_ms,
  SUM(total_tokens)               AS total_tokens,
  SUM(prompt_tokens)              AS prompt_tokens,
  SUM(completion_tokens)          AS completion_tokens,
  SUM(estimated_cost_usd)         AS estimated_cost_usd,
  SUM(error_count)                AS error_count,
  SUM(avg_overhead_ms * request_count) / NULLIF(SUM(request_count), 0) AS avg_overhead_ms,
  SUM(avg_ttfb_ms * request_count) / NULLIF(SUM(request_count), 0)    AS avg_ttfb_ms
FROM hourly_request_metrics
GROUP BY bucket, tenant_id, model, provider
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_request_metrics',
  start_offset    => INTERVAL '2 days',
  end_offset      => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);
```

### 7.4 Compression Policy

```sql
-- Compress chunks older than 7 days (events are rarely queried at raw granularity after that)
ALTER TABLE gateway_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tenant_id',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('gateway_events', INTERVAL '7 days');
```

### 7.5 Retention Policy

```sql
-- Drop raw event chunks older than 90 days.
-- Continuous aggregates (hourly/daily) are retained independently.
SELECT add_retention_policy('gateway_events', INTERVAL '90 days');

-- Keep hourly aggregates for 1 year.
SELECT add_retention_policy('hourly_request_metrics', INTERVAL '365 days');

-- Keep daily aggregates indefinitely (low volume).
```

### 7.6 Query Migration Map

How existing `analytics.ts` query families map to the new schema:

| Current Pattern | Current Source | New Source |
|-----------------|---------------|-----------|
| `getAnalyticsSummary()` | Raw SQL on `traces` with `percentile_cont` | `SELECT` from `hourly_request_metrics` with `SUM`/`AVG` over window |
| `getTimeseriesMetrics()` | `to_timestamp(floor(extract(epoch...) / seconds) * seconds)` | `SELECT` from `hourly_request_metrics` directly (hourly buckets) or `time_bucket()` on raw events for sub-hour |
| `getModelBreakdown()` | `GROUP BY model` on `traces` | `SELECT` from `hourly_request_metrics` grouped by `model` |
| Subtenant rollup | `WITH RECURSIVE subtenant_tree` CTE | Same CTE joined against `hourly_request_metrics.tenant_id` |
| Cost estimation | Inline `CASE WHEN model ILIKE '%gpt-3.5%'` | Pre-computed by worker, stored in `estimated_cost_usd` field |

**Backward compatibility:** The existing `traces` table continues to serve the tenant Recharts dashboards during the transition. The worker writes to both `gateway_events` (new) and `traces` (legacy) until all analytics queries are migrated.

---

## 8. Redis Caching Architecture

### 8.1 Two-Tier Cache Design

```
  Request
    |
    v
 +--------+    miss    +--------+    miss    +--------+
 |   L1   | ---------> |   L2   | ---------> |   DB   |
 | (Map)  |            | (Redis)|            |        |
 | 30s TTL|            | ns TTL |            |        |
 +--------+            +--------+            +--------+
    ^                      |
    |    pub/sub invalidate |
    +----------------------+
```

### 8.2 Cache Service Interface

```typescript
interface CacheService {
  get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined>;
  set<T>(namespace: CacheNamespace, key: string, value: T): Promise<void>;
  invalidate(namespace: CacheNamespace, key: string): Promise<void>;
}

type CacheNamespace = 'tenant_auth' | 'provider_config' | 'agent_config';
```

### 8.3 L1: In-Process Cache

- **Implementation:** `Map<string, { value: unknown; expiresAt: number }>` with lazy eviction on access.
- **Capacity:** 100 entries per namespace (300 total). Evicts oldest on overflow.
- **TTL:** 30 seconds. Short enough that invalidation propagation delay is acceptable.
- **Scope:** Local to each gateway process. Not shared across replicas.

This replaces the current `LRUCache` in `src/auth.ts` (1,000 entries, no TTL).

### 8.4 L2: Redis

- **Client:** `ioredis` with connection pooling and automatic reconnection.
- **Key format:** `arachne:cache:{namespace}:{id}`
  - Example: `arachne:cache:tenant_auth:sha256_abc123def...`
- **TTL per namespace:**

| Namespace | TTL | Rationale |
|-----------|-----|-----------|
| `tenant_auth` | 5 min | Balance between DB load reduction and key revocation latency |
| `provider_config` | 10 min | Provider configs change infrequently |
| `agent_config` | 5 min | Agent updates should propagate within minutes |

- **Serialization:** `JSON.stringify` / `JSON.parse`. Cache values are plain objects (no class instances).

### 8.5 Invalidation via Pub/Sub

When a cached entity is mutated (e.g., API key revoked, agent config updated), the service that performed the mutation publishes an invalidation message:

```typescript
// Channel: arachne:cache:invalidate
// Message format:
interface CacheInvalidation {
  namespace: CacheNamespace;
  key: string;        // specific key, or '*' for namespace-wide flush
  tenantId?: string;  // for tenant-scoped invalidation
}
```

All gateway replicas subscribe to `arachne:cache:invalidate` and clear matching L1 entries on receipt. Redis L2 entries are deleted directly by the publisher.

```typescript
// Publisher side (e.g., in PortalService after revoking a key)
await cacheService.invalidate('tenant_auth', keyHash);
// Under the hood:
//   1. DEL arachne:cache:tenant_auth:{keyHash} from Redis
//   2. PUBLISH arachne:cache:invalidate { namespace: 'tenant_auth', key: keyHash }

// Subscriber side (each gateway process, on startup)
redis.subscribe('arachne:cache:invalidate');
redis.on('message', (channel, msg) => {
  const inv = JSON.parse(msg) as CacheInvalidation;
  l1Cache.delete(inv.namespace, inv.key);
});
```

### 8.6 Graceful Degradation

If Redis is unreachable:
- L1 continues to serve cached data until TTL expiry.
- Cache misses fall through directly to the database.
- Invalidation messages are lost — L1 entries expire naturally via TTL (30s worst case).
- The gateway logs warnings but does not fail requests.

---

## 9. Grafana Operator Dashboards

Grafana connects directly to TimescaleDB as a PostgreSQL data source. Dashboards are provisioned as JSON and version-controlled in `infra/grafana/dashboards/`.

### 9.1 Dashboard: Gateway Overview

| Panel | Query Source | Visualization |
|-------|-------------|---------------|
| Request Rate (RPS) by model | `hourly_request_metrics` | Time series, stacked by model |
| P50/P95/P99 Latency | `gateway_events` with `percentile_cont` | Histogram + time series overlay |
| Gateway Overhead (ms) | `hourly_request_metrics.avg_overhead_ms` | Time series with 20ms target line |
| Error Rate by Provider | `hourly_request_metrics` filtered by `error_count > 0` | Time series, grouped by provider |
| Cache Hit Ratio | `gateway_events` where `event_type IN ('cache.hit', 'cache.miss')` | Gauge (current) + time series (trend) |
| Active Requests | `gateway.process.stats` events | Stat panel |

### 9.2 Dashboard: RAG Pipeline Health

| Panel | Query Source | Visualization |
|-------|-------------|---------------|
| RAG Request Rate | `gateway_events` where `event_type = 'rag.started'` | Time series |
| Embedding Latency (P50/P95) | `gateway_events` where `event_type = 'rag.embedding.completed'` | Histogram |
| Vector Search Latency | `gateway_events` where `event_type = 'rag.search.completed'` | Time series |
| Top Chunk Similarity Distribution | `rag.search.completed` payload `topSimilarity` | Heatmap |
| RAG Failure Rate | `rag.failed` count / `rag.started` count | Stat + time series |
| Fallback-to-No-RAG Rate | `rag.failed` where `fallbackToNoRag = true` | Gauge |

### 9.3 Dashboard: MCP Tool Execution

| Panel | Query Source | Visualization |
|-------|-------------|---------------|
| MCP Round-Trip Rate | `mcp.round_trip.started` events | Time series |
| Per-Tool Latency | `mcp.tool.called` grouped by `toolName` | Bar chart |
| Tool Error Rate | `mcp.tool.called` where `statusCode >= 400` | Table (tool name, error count, rate) |
| Round-Trip Overhead (ms) | `mcp.round_trip.completed` `totalMs` | Histogram |

### 9.4 Dashboard: Infrastructure

| Panel | Query Source | Visualization |
|-------|-------------|---------------|
| Queue Depth | `gateway.queue.depth` events | Time series with alert threshold |
| Worker Lag | Queue consumer lag metric (queue-specific) | Stat panel |
| Heap Memory Usage | `gateway.process.stats` `heapUsedMb` | Time series per replica |
| Event Loop Delay | `gateway.process.stats` `eventLoopDelayMs` | Time series with 100ms alert line |
| Compression Ratio | TimescaleDB `timescaledb_information.compressed_chunk_stats` | Stat panel |

### 9.5 Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| High Gateway Overhead | avg `gatewayOverheadMs` > 20ms over 5 min | Warning |
| Provider Error Spike | error rate > 5% over 5 min | Critical |
| Queue Backpressure | depth > 10,000 events | Warning |
| Worker Stopped | no events consumed for 60s | Critical |
| Memory Leak | heap growth > 100MB over 1 hour | Warning |

---

## 10. Arachne Desktop Mode

Desktop mode provides the full observability pipeline in a single process with no external dependencies beyond SQLite.

### 10.1 InMemoryEventBus

```typescript
class InMemoryEventBus implements EventBus {
  private handlers = new Map<string, EventHandler[]>();

  emit(event: GatewayEvent): void {
    // Dispatch synchronously to all matching handlers.
    // Events are processed in the same tick — acceptable for single-user load.
    for (const [pattern, handlers] of this.handlers) {
      if (this.matches(event.type, pattern)) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            if (result instanceof Promise) result.catch(err =>
              console.error('[eventbus:desktop] handler error:', err)
            );
          } catch (err) {
            console.error('[eventbus:desktop] handler error:', err);
          }
        }
      }
    }
  }

  on(pattern: string, handler: EventHandler): void {
    const list = this.handlers.get(pattern) ?? [];
    list.push(handler);
    this.handlers.set(pattern, list);
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
  }

  private matches(type: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) {
      return type.startsWith(pattern.slice(0, -1));
    }
    return type === pattern;
  }
}
```

### 10.2 InMemoryCacheService

```typescript
class InMemoryCacheService implements CacheService {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined> {
    const entry = this.store.get(`${namespace}:${key}`);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(`${namespace}:${key}`);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(namespace: CacheNamespace, key: string, value: T): Promise<void> {
    const ttlMs = NAMESPACE_TTL[namespace] ?? 60_000;
    this.store.set(`${namespace}:${key}`, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async invalidate(namespace: CacheNamespace, key: string): Promise<void> {
    this.store.delete(`${namespace}:${key}`);
  }
}
```

### 10.3 SQLite Analytics

Desktop mode uses SQLite with the same Recharts dashboards. The `TraceAssembler` writes to a `traces` table in SQLite, and analytics queries use SQLite-compatible SQL:

- `time_bucket()` is replaced by `strftime('%Y-%m-%d %H:00:00', created_at)`.
- `percentile_cont` is replaced by application-level percentile calculation.
- No continuous aggregates; queries run against raw data (acceptable at desktop scale).

### 10.4 Feature Matrix

| Capability | Production | Desktop |
|-----------|-----------|---------|
| EventBus | QueueEventBus | InMemoryEventBus |
| Cache | L1 + Redis L2 | InMemoryCacheService |
| Worker | Separate process | Inline handlers |
| Time-series DB | TimescaleDB | SQLite |
| Trace persistence | PostgreSQL | SQLite |
| Tenant dashboards (Recharts) | Full | Full |
| Operator dashboards (Grafana) | Full | Not available |
| Encryption | AES-256-GCM | AES-256-GCM (same) |
| Multi-replica | Yes | Single process |

---

## 11. Multi-Tenancy in the Event Stream

### 11.1 Tenant as First-Class Field

Every `GatewayEvent` carries `tenantId`. This field is:
- Set by the gateway after auth resolution.
- Used by the worker for per-tenant encryption key derivation.
- Used by continuous aggregates as a segment-by column.
- Used by Grafana dashboards as a filter variable.

### 11.2 Phase 1: Logical Isolation

All events flow through a single queue topic/stream. The worker processes events for all tenants. Tenant isolation is enforced at the query layer:

- Continuous aggregates include `tenant_id` in `GROUP BY`.
- Tenant dashboard queries always filter by `tenant_id`.
- Grafana admin dashboards use a `tenant_id` variable for drill-down.

This is sufficient for early production where tenant count is low and event volume is manageable.

### 11.3 Phase 2: Physical Isolation

As tenant count and event volume grow, introduce per-tenant routing:

```
Events for tenant A  -->  [queue partition/stream A]  -->  Worker group A
Events for tenant B  -->  [queue partition/stream B]  -->  Worker group B
```

- **Routing key:** `tenantId` determines queue partition.
- **Noisy-neighbor prevention:** A high-volume tenant cannot starve others because each partition has dedicated consumer capacity.
- **Premium tenants:** Can be assigned dedicated queue partitions with higher throughput guarantees.

The `QueueAdapter` handles routing — the `EventBus.emit()` interface does not change.

---

## 12. Trace Entity Evolution

### 12.1 Current State

The `Trace` entity (`src/domain/entities/Trace.ts`) is a monolithic row written synchronously (batched, but still on the gateway's event loop) after a request completes. It includes:

- Encrypted request/response bodies
- Latency measurements (total, TTFB, gateway overhead)
- Token counts and cost estimates
- RAG metrics (12 fields)
- Foreign keys to Tenant and Agent

### 12.2 Target State

The `Trace` becomes a **materialized composite** assembled by the worker from lifecycle events:

```
Gateway                    Worker                         PostgreSQL
  |                          |                               |
  |-- request.received ----->|                               |
  |-- auth.resolved -------->|                               |
  |-- rag.*.completed ------>|  TraceAssembler collects      |
  |-- provider.*.completed ->|  events by requestId          |
  |-- request.completed ---->|                               |
  |                          |-- assemble + encrypt -------->|
  |                          |   INSERT INTO traces          |
  |                          |                               |
```

**Benefits:**
- Gateway no longer performs encryption on the hot path.
- Gateway no longer constructs and holds the full Trace object in memory.
- Individual events are independently queryable in TimescaleDB for debugging.
- The Trace row format can evolve without changing the gateway code — only the worker's assembly logic changes.

### 12.3 Multi-Agent Trace Fields

The following columns are added to the `traces` table to support team orchestration, scheduling, and parent/child trace correlation:

```sql
ALTER TABLE traces ADD COLUMN parent_request_id UUID DEFAULT NULL;
ALTER TABLE traces ADD COLUMN team_id UUID DEFAULT NULL;
ALTER TABLE traces ADD COLUMN schedule_id UUID DEFAULT NULL;
```

- `parent_request_id`: links sub-agent traces to the parent team-level trace. When a TeamOrchestrator invokes a sub-agent, the sub-agent's trace carries the team request's ID as its parent.
- `team_id`: identifies the AgentTeam artifact that orchestrated this request (null for single-agent requests).
- `schedule_id`: identifies the Schedule entity that triggered this request (null for on-demand requests).

The `TraceAssembler` uses `parentRequestId` to construct hierarchical trace trees for team execution visualization.

### 12.4 Schema Compatibility

The existing `traces` table schema is otherwise unchanged. The worker populates the same columns from event data. Existing Recharts dashboard queries, portal API endpoints, and admin analytics continue to work without modification.

New fields can be added to `traces` by extracting them from event payloads in the worker, without touching gateway code.

---

## 13. Implementation Phases

### Phase 1: EventBus Interface + Redis Foundation

**Goal:** Establish the abstraction layer and external cache without changing the data flow.

- [ ] Define `EventBus`, `GatewayEvent`, `CacheService` interfaces in `src/observability/interfaces.ts`
- [ ] Implement `InMemoryEventBus` and `InMemoryCacheService` for desktop mode
- [ ] Implement `RedisCacheService` with ioredis (L2 only, no L1 yet)
- [ ] Add `REDIS_URL` env var, graceful fallback when not configured
- [ ] Wire `createEventBus()` and `createCacheService()` factory functions
- [ ] Add worker skeleton (`src/worker.ts`) that connects to queue and logs events

**Estimated effort:** 1 week

### Phase 2: Migrate TraceRecorder to EventBus

**Goal:** Replace the in-process `TraceRecorder` with EventBus emissions.

- [ ] Emit `request.received`, `request.completed`, `provider.response.completed` from `src/index.ts`
- [ ] Implement `TraceAssembler` in the worker
- [ ] Move encryption from `TraceRecorder.record()` to `TraceAssembler.assemble()`
- [ ] Worker writes assembled Trace rows to PostgreSQL `traces` table
- [ ] Validate: tenant dashboards produce identical results
- [ ] Deprecate `TraceRecorder` (keep as fallback behind feature flag)

**Estimated effort:** 1.5 weeks

### Phase 3: TimescaleDB Extension

**Goal:** Add time-series storage alongside existing PostgreSQL.

- [ ] Enable `timescaledb` extension in PostgreSQL (migration)
- [ ] Create `gateway_events` hypertable (migration)
- [ ] Create `hourly_request_metrics` and `daily_request_metrics` continuous aggregates
- [ ] Add `TimeSeriesWriter` to worker: dual-write events to hypertable
- [ ] Configure compression policy (7 days) and retention policy (90 days)
- [ ] Validate: Grafana can query continuous aggregates

**Estimated effort:** 1 week

### Phase 4: Full Event Instrumentation

**Goal:** Emit all 25+ lifecycle events across the request handler.

- [ ] Instrument auth middleware (`auth.resolved`, `auth.failed`)
- [ ] Instrument conversation subsystem (`conversation.*` events)
- [ ] Instrument RAG pipeline (`rag.*` events)
- [ ] Instrument agent application (`agent.config_applied`)
- [ ] Instrument streaming (`stream.first_byte`, `stream.completed`)
- [ ] Instrument MCP round-trip (`mcp.*` events)
- [ ] Instrument cache operations (`cache.*` events)
- [ ] Add periodic health emitters (`gateway.queue.depth`, `gateway.process.stats`)

**Estimated effort:** 2 weeks

### Phase 5: Redis Cache Migration (L1/L2)

**Goal:** Replace the hand-rolled LRU in `src/auth.ts` with two-tier caching.

- [ ] Implement L1 in-process cache with TTL and capacity limit
- [ ] Wire L1 -> L2 -> DB fallthrough in `CacheService`
- [ ] Migrate `registerAuthMiddleware()` to use `CacheService` for tenant resolution
- [ ] Add pub/sub invalidation channel and subscriber
- [ ] Update `invalidateCachedKey()` and `invalidateAllKeysForTenant()` to publish invalidation
- [ ] Add `provider_config` and `agent_config` cache namespaces

**Estimated effort:** 1 week

### Phase 6: Grafana Operator Dashboards

**Goal:** Deploy Grafana and build the four operator dashboards.

- [ ] Add Grafana to `docker-compose.yml` with TimescaleDB data source
- [ ] Build Gateway Overview dashboard
- [ ] Build RAG Pipeline Health dashboard
- [ ] Build MCP Tool Execution dashboard
- [ ] Build Infrastructure dashboard
- [ ] Configure alerting rules (overhead, error spike, queue depth, worker health)
- [ ] Version-control dashboard JSON in `infra/grafana/dashboards/`

**Estimated effort:** 1.5 weeks

### Phase 7: Desktop Mode Adapters

**Goal:** Ensure single-binary mode works with full analytics parity.

- [ ] Wire `InMemoryEventBus` when `ARACHNE_MODE=desktop` or `DB_DRIVER=sqlite`
- [ ] Wire `InMemoryCacheService` when Redis is not configured
- [ ] Adapt `TraceAssembler` to write to SQLite
- [ ] Implement SQLite-compatible analytics queries (replace `time_bucket`, `percentile_cont`)
- [ ] Validate: Recharts dashboards render correctly with SQLite backend
- [ ] Add integration tests for desktop mode pipeline

**Estimated effort:** 1 week

---

**Total estimated effort:** ~9-10 weeks for a single engineer, with phases 1-2 providing immediate value (decoupled tracing, encryption off hot path) and subsequent phases layering on deeper analytics capabilities.
