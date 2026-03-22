# Job Queue Architecture

> Tracked by [#185](https://github.com/Synaptic-Weave/arachne/issues/185)

**Status:** Draft
**Author:** Arachne Team
**Last Updated:** 2026-03-22

---

## 1. Overview

Large KB file uploads (150MB+) currently run embedding synchronously during the HTTP request, taking 30+ minutes with TPM rate limiting. If the browser tab closes or the machine sleeps, the work is lost. This spec defines a durable background job queue that processes long-running tasks asynchronously, starting with KB embedding as the first consumer.

### 1.1 Design Goals

1. **DB-backed durability**: jobs survive server restarts via a `jobs` table in MikroORM
2. **Dual DB support**: works with both Postgres and SQLite (desktop mode)
3. **Zero new dependencies**: uses existing database, no Redis/BullMQ/PgBoss
4. **Resumable**: checkpoint-based recovery so failed jobs resume from last progress, not from zero
5. **Observable**: progress reporting with ETA for frontend polling
6. **Migration path to AgentBus**: when agent messaging ships (see [agent_messaging.md](agent_messaging.md)), JobService transitions from DB polling to message-driven dispatch

### 1.2 Non-Goals

- Multi-process worker pool (Phase 1 is single-process)
- Worker threads for CPU-bound work (Phase 2 optimization, see section 10)
- Cross-tenant job visibility
- Job scheduling/cron (future)

---

## 2. Job Entity

### 2.1 Entity Class (`src/domain/entities/Job.ts`)

```typescript
import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export class Job {
  id!: string;
  tenant!: Tenant;
  type!: string;
  status!: JobStatus;
  priority!: number;
  progress!: Record<string, unknown> | null;
  result!: Record<string, unknown> | null;
  error!: string | null;
  metadata!: Record<string, unknown>;
  checkpoint!: Record<string, unknown> | null;
  retryCount!: number;
  maxRetries!: number;
  createdAt!: Date;
  startedAt!: Date | null;
  completedAt!: Date | null;
  updatedAt!: Date;

  constructor(
    tenant: Tenant,
    type: string,
    metadata: Record<string, unknown>,
    options?: { priority?: number; maxRetries?: number },
  ) {
    this.id = randomUUID();
    this.tenant = tenant;
    this.type = type;
    this.status = 'pending';
    this.priority = options?.priority ?? 0;
    this.progress = null;
    this.result = null;
    this.error = null;
    this.metadata = metadata;
    this.checkpoint = null;
    this.retryCount = 0;
    this.maxRetries = options?.maxRetries ?? 3;
    this.createdAt = new Date();
    this.startedAt = null;
    this.completedAt = null;
    this.updatedAt = new Date();
  }

  markRunning(): void {
    this.status = 'running';
    this.startedAt = new Date();
    this.updatedAt = new Date();
  }

  updateProgress(progress: Record<string, unknown>): void {
    this.progress = progress;
    this.updatedAt = new Date();
  }

  updateCheckpoint(checkpoint: Record<string, unknown>): void {
    this.checkpoint = checkpoint;
    this.updatedAt = new Date();
  }

  markCompleted(result: Record<string, unknown>): void {
    this.status = 'completed';
    this.result = result;
    this.completedAt = new Date();
    this.updatedAt = new Date();
  }

  markFailed(error: string): void {
    this.status = 'failed';
    this.error = error;
    this.completedAt = new Date();
    this.updatedAt = new Date();
  }

  markCancelled(): void {
    this.status = 'cancelled';
    this.completedAt = new Date();
    this.updatedAt = new Date();
  }

  canRetry(): boolean {
    return this.retryCount < this.maxRetries;
  }

  resetForRetry(): void {
    this.status = 'pending';
    this.retryCount += 1;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.updatedAt = new Date();
    // checkpoint is intentionally preserved for resumption
  }
}
```

### 2.2 Entity Schema (`src/domain/schemas/Job.schema.ts`)

```typescript
import { EntitySchema } from '@mikro-orm/core';
import { Job } from '../entities/Job.js';
import { Tenant } from '../entities/Tenant.js';

export const JobSchema = new EntitySchema<Job>({
  class: Job,
  tableName: 'jobs',
  properties: {
    id: { type: 'uuid', primary: true },
    tenant: { kind: 'm:1', entity: () => Tenant, fieldName: 'tenant_id' },
    type: { type: 'string', columnType: 'varchar(50)' },
    status: { type: 'string', columnType: 'varchar(20)', default: 'pending' },
    priority: { type: 'integer', default: 0 },
    progress: { type: 'json', nullable: true },
    result: { type: 'json', nullable: true },
    error: { type: 'text', nullable: true },
    metadata: { type: 'json', default: '{}' },
    checkpoint: { type: 'json', nullable: true },
    retryCount: { type: 'integer', fieldName: 'retry_count', default: 0 },
    maxRetries: { type: 'integer', fieldName: 'max_retries', default: 3 },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    startedAt: { type: 'Date', fieldName: 'started_at', nullable: true },
    completedAt: { type: 'Date', fieldName: 'completed_at', nullable: true },
    updatedAt: {
      type: 'Date',
      fieldName: 'updated_at',
      onCreate: () => new Date(),
      onUpdate: () => new Date(),
    },
  },
});
```

Notes:
- JSON columns use `type: 'json'` (MikroORM maps to `jsonb` on Postgres, handles serialization for SQLite)
- Follows the `SmokeTestRun.schema.ts` pattern for JSON + nullable fields

---

## 3. Database Migration

### 3.1 Migration (`migrations/1000000000035_create-jobs.cjs`)

```javascript
exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.createTable('jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: '"tenants"', onDelete: 'CASCADE' },
    type: { type: 'varchar(50)', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: "'pending'" },
    priority: { type: 'integer', notNull: true, default: 0 },
    progress: { type: 'jsonb' },
    result: { type: 'jsonb' },
    error: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'") },
    checkpoint: { type: 'jsonb' },
    retry_count: { type: 'integer', notNull: true, default: 0 },
    max_retries: { type: 'integer', notNull: true, default: 3 },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') },
    started_at: { type: 'timestamp' },
    completed_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('jobs', ['tenant_id'], { name: 'idx_jobs_tenant' });
  pgm.createIndex('jobs', ['type', 'status', 'priority', 'created_at'], { name: 'idx_jobs_claim' });
  pgm.createIndex('jobs', ['status', 'started_at'], { name: 'idx_jobs_stale_recovery' });
};

exports.down = async (pgm) => {
  pgm.dropTable('jobs');
};
```

### 3.2 SQLite Compatibility

| Concern | Postgres | SQLite | Mitigation |
|---------|----------|--------|------------|
| UUID default | `gen_random_uuid()` | N/A | MikroORM generates IDs via `randomUUID()` |
| JSON columns | `jsonb` with operators | `text` with JSON functions | All JSON access in TypeScript, no SQL operators |
| `FOR UPDATE SKIP LOCKED` | Native row-level locking | Not supported | JobService detects driver, uses simple findOne for SQLite |
| `now()` | Native | N/A | Only in migration (Postgres-only). Entity code uses `new Date()` |

The migration is Postgres-only DDL. For SQLite, MikroORM's SchemaGenerator creates the table from the EntitySchema (same pattern as all existing entities).

---

## 4. JobService (`src/application/services/JobService.ts`)

```typescript
export class JobService {
  constructor(private readonly em: EntityManager) {}

  async submit(tenantId, type, metadata, options?): Promise<string>
  async poll(jobId, tenantId): Promise<JobDetail | null>
  async cancel(jobId, tenantId): Promise<boolean>
  async listForTenant(tenantId, filters?): Promise<JobSummary[]>
  async claimNextPending(type): Promise<Job | null>
  async updateProgress(jobId, progress, checkpoint?): Promise<void>
  async complete(jobId, result): Promise<void>
  async fail(jobId, error): Promise<void>
  async recoverStaleJobs(thresholdMinutes?): Promise<number>
```

Key methods:

- **`claimNextPending`**: on Postgres uses `UPDATE ... RETURNING` with `FOR UPDATE SKIP LOCKED` for atomic, contention-free claiming. On SQLite (single-process), falls back to findOne + update.
- **`fail`**: if `retryCount < maxRetries`, calls `resetForRetry()` (preserves checkpoint for resumption). Otherwise marks as failed.
- **`recoverStaleJobs`**: runs on server startup. Jobs stuck in `running` longer than threshold (default 10 min) are reset to pending or failed.

---

## 5. API Endpoints

```
POST   /v1/portal/jobs      → 202 { jobId }
GET    /v1/portal/jobs       → 200 { jobs: JobSummary[] }  (query: ?status=&type=)
GET    /v1/portal/jobs/:id   → 200 JobDetail | 404
DELETE /v1/portal/jobs/:id   → 200 { status: 'cancelled' } | 404
```

All endpoints are tenant-scoped via Portal JWT auth.

---

## 6. KB Embedding as First Job Type

### 6.1 Submission Flow

The `POST /v1/portal/knowledge-bases` endpoint changes from synchronous to async:

1. Parse multipart upload (files + name)
2. Resolve embedder config
3. Chunk text (fast, stays synchronous)
4. Submit a `kb-embedding` job with metadata containing chunks, embedder config, and artifact details
5. Return `202 { jobId, status: 'processing' }`

### 6.2 Type-Specific Payload Contracts

```typescript
// metadata (input, set at submission)
interface KbEmbeddingMetadata {
  artifactName: string;
  org: string;
  embedderConfig: EmbeddingAgentConfig;
  chunks: Array<{ content: string; sourcePath: string }>;
  sha256: string;
  preprocessingHash: string;
}

// progress (updated per rate batch)
interface KbEmbeddingProgress {
  totalChunks: number;
  completedChunks: number;
  currentRateBatch: number;
  totalRateBatches: number;
  estimatedSecondsRemaining: number | null;
  failedChunks: number;
  phase: 'embedding' | 'persisting' | 'complete' | 'failed';
  message: string;
}

// checkpoint (for resumption)
interface KbEmbeddingCheckpoint {
  lastCompletedRateBatch: number;
  embeddedChunkCount: number;
}

// result (on completion)
interface KbEmbeddingResult {
  artifactId: string;
  chunkCount: number;
  durationMs: number;
}
```

### 6.3 Progress Update Cadence

| Event | Update DB? | Rationale |
|-------|-----------|-----------|
| Job starts | Yes | Sets phase, totalChunks, totalRateBatches |
| Each rate batch completes | Yes | Updates completedChunks, currentRateBatch, ETA |
| Rate limit pause begins | Yes | Updates message ("Waiting 60s...") |
| Each API batch completes | No | Too frequent (10+ writes/min) |
| Job completes/fails | Yes | Final state |

Progress is persisted roughly every 60 seconds (once per rate batch), which is good cadence for meaningful UI updates without write amplification.

---

## 7. Concurrency Model

### 7.1 Concurrent API Batches Within Rate Windows

Current: API batches of 100 texts sent sequentially within each rate window.
Proposed: fan-out with `Promise.allSettled()` on up to N concurrent API batches.

```typescript
const PROVIDER_CONCURRENCY: Record<string, number> = {
  openai: 10,   // 500+ RPM typical
  azure: 6,     // stricter per-deployment limits
  ollama: 1,    // no batch support
};
```

The token budget (260k per window) is NOT split. All concurrent batches share the same budget (the rate-batch grouping already ensures the total stays under budget). Concurrency reduces wall-clock time per window by overlapping API round-trips.

### 7.2 Error Handling for Concurrent Batches

Use `Promise.allSettled()` so one failed batch does not cancel the others:

- **429 (rate limit)**: wait for `Retry-After` header (or 60s default), retry those batches
- **5xx (server error)**: retry up to 3 times with exponential backoff (1s, 4s, 16s)
- **4xx (client error, not 429)**: fail permanently, record partial-failure
- Successfully embedded chunks from the same wave are preserved regardless

---

## 8. Failure Modes and Recovery

### 8.1 Server Restart Mid-Embedding

On startup, JobService calls `recoverStaleJobs(10)`:
- Jobs in `running` state with `startedAt` older than 10 minutes are reset to `pending` (if retries remain) or `failed`
- The worker picks them up on the next poll cycle
- `checkpoint` is preserved, so the worker resumes from last progress

### 8.2 Stale Job Detection

The longest expected silence during normal operation is the 60s rate-limit pause. A job without a heartbeat for 2 minutes (double the window) is considered stale. Running jobs should update `updatedAt` at:
- Start of each rate batch
- Start of rate-limit pause
- Completion of each concurrent wave

### 8.3 Resumption Strategy

On retry, the KB embedding worker checks `job.checkpoint`:
- If null: start from beginning
- If `{ lastCompletedRateBatch: 5, embeddedChunkCount: 2000 }`: skip completed batches, resume from batch 6
- Verify actual DB state (query `kb_chunks` count) in case a crash occurred between embedding and persisting

### 8.4 Partial Results

If a job fails after 80% of chunks are embedded:
- Persisted chunks remain in `kb_chunks` (queryable by RAG immediately)
- Job status shows `failedChunks` count
- User can retry (resumes from checkpoint)
- Deployment with partial KB is allowed with a warning

### 8.5 Maximum Job Duration

```typescript
const MAX_JOB_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
```

A 150MB file produces roughly 57k chunks, requiring about 143 rate windows (2.4 hours). The 4-hour limit provides headroom for retries.

---

## 9. Integration with Agent Messaging (AgentBus)

### 9.1 Event Taxonomy

| Event | Bus | Fires When | Key Fields |
|-------|-----|------------|------------|
| `job.submitted` | EventBus | Job enqueued | jobId, jobType, tenantId |
| `job.started` | EventBus | Worker claims job | jobId, jobType |
| `job.progress` | EventBus | Rate batch completes | jobId, completedChunks, totalChunks |
| `job.completed` | EventBus + AgentBus | Job succeeds | jobId, durationMs, resultSummary |
| `job.failed` | EventBus + AgentBus | Job fails (retries exhausted) | jobId, error |

Only terminal events go via AgentBus (durable). Progress events are observability-only.

### 9.2 Migration Path

```
Phase 1 (MVP):  JobService polls `jobs` table every 5s for pending work
Phase 2 (Bus):  JobService subscribes to AgentBus 'system-jobs' channel.
                Submission sends an AgentMessage; handler creates DB row + executes.
                DB row remains source of truth for state and resumability.
```

The DB polling is replaced by message-driven dispatch, reducing latency from 5s to near-instant.

---

## 10. Future Extensions

### 10.1 Worker Threads (Phase 2)

Worker threads (`node:worker_threads`) become beneficial when:
- Chunking files larger than 200MB (where chunking exceeds 1 second on main thread)
- Multiple KB jobs run concurrently (CPU contention)
- Custom chunking strategies involving NLP processing

**MVP approach:** chunking runs as a synchronous function call within the job handler. The `JobHandler` interface makes it easy to extract to a worker later without changing the job queue architecture.

### 10.2 Job Scheduling/Cron

Recurring jobs (e.g., periodic KB re-embedding) are out of scope but the `jobs` table could support a `scheduled_at` field in a future migration.

### 10.3 Priority Queues

The `priority` field is already present. Higher values mean higher priority. The `claimNextPending` query orders by `priority DESC, created_at ASC`.

---

## 11. Portal UX

### 11.1 Upload Flow Change

**Before:** Upload button shows "Creating... (chunking & embedding)" for 30+ minutes
**After:** Upload returns immediately with "Processing..." status, KB appears in list with a progress indicator

### 11.2 Progress Polling

Frontend polls `GET /v1/portal/jobs/:id` every 5 seconds while status is `pending` or `running`. Displays:
- Progress bar (completedChunks / totalChunks)
- Current phase ("Embedding rate-batch 3/8")
- Estimated time remaining
- Error details if failed, with retry button

### 11.3 KB List Integration

KBs with active embedding jobs show a "Processing" badge instead of chunk count. Clicking shows the job detail with progress.

---

## 12. Security

- All jobs are tenant-scoped via `tenant_id` FK
- All API endpoints filter by `tenantId` from Portal JWT
- Job metadata may contain embedder config (including API keys); same encryption-at-rest rules apply as for provider config
- `claimNextPending` is an internal method (not exposed via API); the polling loop runs server-side
