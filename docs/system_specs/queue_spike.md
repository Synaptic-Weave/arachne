# Queue Technology Spike: Durable Trace Recording

**Status:** Draft
**Author:** Spike investigation
**Date:** 2026-03-16

## Problem Statement

The current `TraceRecorder` in `src/tracing.ts` buffers trace events in an in-memory array and flushes to PostgreSQL every 5 seconds or 100 rows. If the gateway process crashes, all buffered traces are lost. We need a durable message queue so that:

1. Trace data survives gateway crashes
2. Publishing remains non-blocking (< 1ms on the hot path)
3. A separate worker container consumes events and writes to TimescaleDB
4. Desktop mode (single process, zero dependencies) still works via an in-memory adapter
5. The same queue infrastructure can later support agent team orchestration (sagas/workflows)

## Common Interface

All adapters implement this interface. The gateway imports `EventQueue` and never knows which backend is active.

```typescript
// src/queue/types.ts

import type { TraceInput } from '../tracing.js';

export interface TraceEvent {
  id: string;          // UUID, assigned at publish time
  timestamp: number;   // Date.now()
  payload: TraceInput;
}

export type TraceHandler = (event: TraceEvent) => Promise<void>;

export interface EventQueue {
  /** One-time setup. Called at server startup. */
  connect(): Promise<void>;

  /** Publish a trace event. Must be non-blocking on the hot path. */
  publish(event: TraceEvent): Promise<void>;

  /**
   * Start consuming events. Called by the worker process.
   * The handler receives one event at a time; throwing triggers retry.
   */
  subscribe(handler: TraceHandler): Promise<void>;

  /** Graceful shutdown. Flushes pending work and closes connections. */
  close(): Promise<void>;
}
```

Factory that reads config and returns the right adapter:

```typescript
// src/queue/index.ts

import type { EventQueue } from './types.js';

export function createQueue(): EventQueue {
  const driver = process.env.QUEUE_DRIVER ?? 'memory';

  switch (driver) {
    case 'bullmq':
      return new (require('./bullmq.js').BullMQQueue)();
    case 'temporal':
      return new (require('./temporal.js').TemporalQueue)();
    case 'rabbitmq':
      return new (require('./rabbitmq.js').RabbitMQQueue)();
    case 'azuresb':
      return new (require('./azuresb.js').AzureServiceBusQueue)();
    case 'memory':
    default:
      return new (require('./memory.js').InMemoryQueue)();
  }
}
```

---

## 1. BullMQ (Redis-backed)

**npm:** `bullmq` (single package, includes both producer and worker)
**Requires:** Redis 7+

### a. Producer Code Sample

```typescript
// src/queue/bullmq.ts

import { Queue, Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { EventQueue, TraceEvent, TraceHandler } from './types.js';

const QUEUE_NAME = 'arachne:traces';

export class BullMQQueue implements EventQueue {
  private queue!: Queue;
  private worker?: Worker;

  private readonly connection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  async connect(): Promise<void> {
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,  // keep last 1k for debugging
        removeOnFail: 5_000,      // keep last 5k failures
      },
    });
  }

  async publish(event: TraceEvent): Promise<void> {
    // add() returns a promise but the actual Redis XADD is sub-ms
    await this.queue.add('trace', event, { jobId: event.id });
  }

  async subscribe(handler: TraceHandler): Promise<void> {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<TraceEvent>) => {
        await handler(job.data);
      },
      {
        connection: this.connection,
        concurrency: 10,
        limiter: { max: 500, duration: 1_000 },  // max 500 jobs/sec
      },
    );

    this.worker.on('failed', (job, err) => {
      console.error(`[bullmq] Job ${job?.id} failed: ${err.message}`);
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
```

**Gateway usage (replacing TraceRecorder.record):**

```typescript
// src/index.ts (at startup)
import { createQueue } from './queue/index.js';
import { randomUUID } from 'node:crypto';
import { encryptTraceBody } from './encryption.js';

const queue = createQueue();
await queue.connect();

// In the request handler, replacing traceRecorder.record(trace):
const event: TraceEvent = {
  id: randomUUID(),
  timestamp: Date.now(),
  payload: trace,  // TraceInput — encryption moves to the worker
};
void queue.publish(event);  // fire-and-forget
```

### b. Consumer/Worker Code Sample

```typescript
// src/worker.ts — separate entrypoint: `node dist/worker.js`

import { createQueue } from './queue/index.js';
import { initOrm } from './orm.js';
import { encryptTraceBody } from './encryption.js';
import { Trace } from './domain/entities/Trace.js';
import { Tenant } from './domain/entities/Tenant.js';
import { Agent } from './domain/entities/Agent.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from './queue/types.js';

async function main() {
  const orm = await initOrm();
  const em = orm.em;
  const queue = createQueue();
  await queue.connect();

  await queue.subscribe(async (event: TraceEvent) => {
    const { payload: input } = event;
    const forkedEm = em.fork();

    // Encryption happens here, off the gateway hot path
    const reqBodyJson = JSON.stringify(input.requestBody);
    const { ciphertext: reqCt, iv: reqIv } = encryptTraceBody(input.tenantId, reqBodyJson);

    let resCt: string | null = null;
    let resIv: string | null = null;
    if (input.responseBody != null) {
      const enc = encryptTraceBody(input.tenantId, JSON.stringify(input.responseBody));
      resCt = enc.ciphertext;
      resIv = enc.iv;
    }

    const trace = new Trace();
    trace.id = event.id;
    trace.tenant = forkedEm.getReference(Tenant, input.tenantId);
    trace.agent = input.agentId
      ? forkedEm.getReference(Agent, input.agentId)
      : null;
    trace.requestId = input.requestId ?? randomUUID();
    trace.model = input.model;
    trace.provider = input.provider;
    trace.endpoint = input.endpoint ?? '/v1/chat/completions';
    trace.requestBody = reqCt;
    trace.requestIv = reqIv;
    trace.responseBody = resCt;
    trace.responseIv = resIv;
    trace.latencyMs = input.latencyMs;
    trace.promptTokens = input.promptTokens ?? null;
    trace.completionTokens = input.completionTokens ?? null;
    trace.totalTokens = input.totalTokens ?? null;
    trace.estimatedCostUsd = null;
    trace.encryptionKeyVersion = 1;
    trace.statusCode = input.statusCode ?? null;
    trace.ttfbMs = input.ttfbMs ?? null;
    trace.gatewayOverheadMs = input.gatewayOverheadMs ?? null;
    trace.createdAt = new Date(event.timestamp);
    // RAG fields
    trace.knowledgeBaseId = input.knowledgeBaseId ?? null;
    trace.embeddingAgentId = input.embeddingAgentId ?? null;
    trace.ragRetrievalLatencyMs = input.ragRetrievalLatencyMs ?? null;
    trace.embeddingLatencyMs = input.embeddingLatencyMs ?? null;
    trace.vectorSearchLatencyMs = input.vectorSearchLatencyMs ?? null;
    trace.retrievedChunkCount = input.retrievedChunkCount ?? null;
    trace.topChunkSimilarity = input.topChunkSimilarity ?? null;
    trace.avgChunkSimilarity = input.avgChunkSimilarity ?? null;
    trace.contextTokensAdded = input.contextTokensAdded ?? null;
    trace.ragOverheadTokens = input.ragOverheadTokens ?? null;
    trace.ragCostOverheadUsd = input.ragCostOverheadUsd ?? null;
    trace.ragStageFailed = input.ragStageFailed ?? null;
    trace.fallbackToNoRag = input.fallbackToNoRag ?? null;

    forkedEm.persist(trace);
    await forkedEm.flush();
  });

  console.log('[worker] Listening for trace events...');
}

main().catch((err) => {
  console.error('[worker] Fatal:', err);
  process.exit(1);
});
```

### c. Desktop In-Memory Adapter

```typescript
// src/queue/memory.ts

import type { EventQueue, TraceEvent, TraceHandler } from './types.js';

/**
 * In-memory queue for Desktop mode. Processes events in a microtask,
 * matching the current TraceRecorder behavior without external dependencies.
 */
export class InMemoryQueue implements EventQueue {
  private buffer: TraceEvent[] = [];
  private handler?: TraceHandler;
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;

  private readonly batchSize = 100;
  private readonly flushIntervalMs = 5_000;

  async connect(): Promise<void> {
    // No-op — nothing to connect to
  }

  async publish(event: TraceEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.drain();
    }
  }

  async subscribe(handler: TraceHandler): Promise<void> {
    this.handler = handler;
    this.timer = setInterval(() => { void this.drain(); }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.processing || this.buffer.length === 0 || !this.handler) return;
    this.processing = true;

    const batch = this.buffer.splice(0);
    for (const event of batch) {
      try {
        await this.handler(event);
      } catch (err) {
        console.error('[memory-queue] Handler failed:', err);
        // No retry in memory mode — matches current TraceRecorder behavior
      }
    }
    this.processing = false;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.drain();
  }
}
```

### d. Docker Compose Addition

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes  # AOF persistence
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  trace-worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: node dist/worker.js
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://loom:loom_dev_password@postgres:5432/loom
      QUEUE_DRIVER: bullmq
      REDIS_HOST: redis
      REDIS_PORT: 6379
      ENCRYPTION_MASTER_KEY: "0000000000000000000000000000000000000000000000000000000000000001"

# Add to volumes:
  redis_data:
```

### e. Error Handling

```typescript
// Retry is configured in defaultJobOptions (see producer above):
// attempts: 5, exponential backoff starting at 1s → 1s, 2s, 4s, 8s, 16s

// Dead-letter: BullMQ moves jobs to a "failed" set after all attempts are
// exhausted. Jobs remain visible in Bull Board for inspection.
// To reprocess failed jobs:
import { Queue } from 'bullmq';
const queue = new Queue('arachne:traces', { connection });
const failed = await queue.getFailed(0, 100);
for (const job of failed) {
  await job.retry();
}
```

**When the worker is down:** Redis buffers all published jobs. BullMQ uses Redis Streams (XADD/XREADGROUP), so messages persist until consumed. Memory usage grows with backlog — Redis `maxmemory` should be configured. At ~2 KB per trace event, 1 GB of Redis holds ~500,000 buffered traces.

### f. Agent Team Readiness

BullMQ has no built-in saga or workflow primitives. Multi-agent orchestration would require building a state machine on top of BullMQ's job dependencies and flow producer (`FlowProducer`). The `FlowProducer` supports parent-child job trees, which maps loosely to coordinator-dispatches-to-sub-agents, but partial failure handling, compensation steps, and timeout coordination would all be custom code.

**Verdict:** Workable for simple fan-out patterns. Inadequate for complex multi-step agent orchestration without significant custom work.

---

## 2. Temporal.io

**npm:** `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`
**Requires:** Temporal server (single Go binary) + persistence backend (can use existing PostgreSQL)

### a. Producer Code Sample

```typescript
// src/queue/temporal.ts

import { Client, Connection } from '@temporalio/client';
import type { EventQueue, TraceEvent, TraceHandler } from './types.js';

const TASK_QUEUE = 'arachne-traces';

export class TemporalQueue implements EventQueue {
  private client!: Client;
  private workerInstance?: import('@temporalio/worker').Worker;

  async connect(): Promise<void> {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    this.client = new Client({ connection });
  }

  async publish(event: TraceEvent): Promise<void> {
    // Start a workflow execution — Temporal persists it immediately
    await this.client.workflow.start('processTrace', {
      taskQueue: TASK_QUEUE,
      workflowId: `trace-${event.id}`,
      args: [event],
    });
  }

  async subscribe(handler: TraceHandler): Promise<void> {
    const { Worker } = await import('@temporalio/worker');

    this.workerInstance = await Worker.create({
      workflowsPath: new URL('./temporal-workflows.js', import.meta.url).pathname,
      activities: {
        persistTrace: async (event: TraceEvent) => {
          await handler(event);
        },
      },
      taskQueue: TASK_QUEUE,
      maxConcurrentWorkflowTaskExecutions: 50,
      maxConcurrentActivityTaskExecutions: 20,
    });

    // Run blocks until worker is shut down
    void this.workerInstance.run();
  }

  async close(): Promise<void> {
    this.workerInstance?.shutdown();
  }
}
```

**Workflow definition (must be in a separate file for Temporal's deterministic sandbox):**

```typescript
// src/queue/temporal-workflows.ts

import { proxyActivities } from '@temporalio/workflow';
import type { TraceEvent } from './types.js';

const { persistTrace } = proxyActivities<{
  persistTrace(event: TraceEvent): Promise<void>;
}>({
  startToCloseTimeout: '30s',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

export async function processTrace(event: TraceEvent): Promise<void> {
  await persistTrace(event);
}
```

### b. Consumer/Worker Code Sample

The worker is part of the `subscribe()` call above. In production, the worker runs as a separate process:

```typescript
// src/temporal-worker.ts — entrypoint: `node dist/temporal-worker.js`

import { Worker } from '@temporalio/worker';
import { initOrm } from './orm.js';
import { encryptTraceBody } from './encryption.js';
import { Trace } from './domain/entities/Trace.js';
import { Tenant } from './domain/entities/Tenant.js';
import { Agent } from './domain/entities/Agent.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from './queue/types.js';

async function main() {
  const orm = await initOrm();
  const em = orm.em;

  const worker = await Worker.create({
    workflowsPath: new URL('./queue/temporal-workflows.js', import.meta.url).pathname,
    activities: {
      persistTrace: async (event: TraceEvent) => {
        const { payload: input } = event;
        const forkedEm = em.fork();

        const reqBodyJson = JSON.stringify(input.requestBody);
        const { ciphertext: reqCt, iv: reqIv } = encryptTraceBody(input.tenantId, reqBodyJson);

        let resCt: string | null = null;
        let resIv: string | null = null;
        if (input.responseBody != null) {
          const enc = encryptTraceBody(input.tenantId, JSON.stringify(input.responseBody));
          resCt = enc.ciphertext;
          resIv = enc.iv;
        }

        const trace = new Trace();
        trace.id = event.id;
        trace.tenant = forkedEm.getReference(Tenant, input.tenantId);
        trace.agent = input.agentId
          ? forkedEm.getReference(Agent, input.agentId)
          : null;
        trace.requestId = input.requestId ?? randomUUID();
        trace.model = input.model;
        trace.provider = input.provider;
        trace.endpoint = input.endpoint ?? '/v1/chat/completions';
        trace.requestBody = reqCt;
        trace.requestIv = reqIv;
        trace.responseBody = resCt;
        trace.responseIv = resIv;
        trace.latencyMs = input.latencyMs;
        trace.promptTokens = input.promptTokens ?? null;
        trace.completionTokens = input.completionTokens ?? null;
        trace.totalTokens = input.totalTokens ?? null;
        trace.estimatedCostUsd = null;
        trace.encryptionKeyVersion = 1;
        trace.statusCode = input.statusCode ?? null;
        trace.ttfbMs = input.ttfbMs ?? null;
        trace.gatewayOverheadMs = input.gatewayOverheadMs ?? null;
        trace.createdAt = new Date(event.timestamp);
        // RAG fields
        trace.knowledgeBaseId = input.knowledgeBaseId ?? null;
        trace.embeddingAgentId = input.embeddingAgentId ?? null;
        trace.ragRetrievalLatencyMs = input.ragRetrievalLatencyMs ?? null;
        trace.embeddingLatencyMs = input.embeddingLatencyMs ?? null;
        trace.vectorSearchLatencyMs = input.vectorSearchLatencyMs ?? null;
        trace.retrievedChunkCount = input.retrievedChunkCount ?? null;
        trace.topChunkSimilarity = input.topChunkSimilarity ?? null;
        trace.avgChunkSimilarity = input.avgChunkSimilarity ?? null;
        trace.contextTokensAdded = input.contextTokensAdded ?? null;
        trace.ragOverheadTokens = input.ragOverheadTokens ?? null;
        trace.ragCostOverheadUsd = input.ragCostOverheadUsd ?? null;
        trace.ragStageFailed = input.ragStageFailed ?? null;
        trace.fallbackToNoRag = input.fallbackToNoRag ?? null;

        forkedEm.persist(trace);
        await forkedEm.flush();
      },
    },
    taskQueue: 'arachne-traces',
    maxConcurrentWorkflowTaskExecutions: 50,
    maxConcurrentActivityTaskExecutions: 20,
  });

  console.log('[temporal-worker] Starting...');
  await worker.run();
}

main().catch((err) => {
  console.error('[temporal-worker] Fatal:', err);
  process.exit(1);
});
```

### c. Desktop In-Memory Adapter

Temporal has no in-memory mode. Desktop would use the same `InMemoryQueue` from section 1c. The `EventQueue` interface abstracts this cleanly — if `QUEUE_DRIVER=memory`, Temporal is never imported.

### d. Docker Compose Addition

```yaml
  temporal:
    image: temporalio/auto-setup:latest
    ports:
      - "7233:7233"      # gRPC frontend
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=loom
      - POSTGRES_PWD=loom_dev_password
      - POSTGRES_SEEDS=postgres
      - DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/development-sql.yaml
    depends_on:
      postgres:
        condition: service_healthy

  temporal-ui:
    image: temporalio/ui:latest
    ports:
      - "8080:8080"
    environment:
      - TEMPORAL_ADDRESS=temporal:7233

  trace-worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: node dist/temporal-worker.js
    depends_on:
      temporal:
        condition: service_started
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://loom:loom_dev_password@postgres:5432/loom
      TEMPORAL_ADDRESS: temporal:7233
      ENCRYPTION_MASTER_KEY: "0000000000000000000000000000000000000000000000000000000000000001"
```

### e. Error Handling

Temporal handles retries declaratively in the workflow definition (see `proxyActivities` retry config above). Failed activities are retried automatically. After all attempts are exhausted, the workflow execution fails and is visible in the Temporal UI with full execution history.

**When the worker is down:** Temporal server queues workflow tasks in its own database. When the worker comes back online, it picks up all pending tasks. There is no message loss — Temporal's persistence guarantees are its core value proposition. No backpressure configuration needed on the producer side.

**DLQ equivalent:** Failed workflows remain in "Failed" state in Temporal. They can be reset or restarted via the CLI (`tctl`) or the UI. There is no separate dead-letter queue concept because Temporal retains full execution history.

### f. Agent Team Readiness

This is Temporal's strongest suit. Multi-agent orchestration maps directly to Temporal's programming model:

```typescript
// Example: agent team coordination as a Temporal workflow
import { proxyActivities, sleep } from '@temporalio/workflow';

const { dispatchToAgent, collectResult } = proxyActivities<AgentActivities>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3 },
});

export async function coordinateAgentTeam(task: TeamTask): Promise<TeamResult> {
  // Fan-out to sub-agents
  const handles = task.agents.map((agent) =>
    dispatchToAgent({ agent, task: task.subtask })
  );

  const results = await Promise.allSettled(handles);

  // Handle partial failures — compensation / fallback
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    await compensatePartialFailures(failures);
  }

  return aggregateResults(results);
}
```

Temporal provides: saga compensation via try/catch, child workflows for sub-agent isolation, timers and deadlines, signal/query for external coordination, versioning for workflow evolution.

**Verdict:** Purpose-built for exactly this use case. Best-in-class saga and orchestration support.

---

## 3. RabbitMQ

**npm:** `amqplib` (low-level AMQP 0-9-1 client)
**Requires:** RabbitMQ server (Erlang runtime, ~150 MB image)

### a. Producer Code Sample

```typescript
// src/queue/rabbitmq.ts

import amqplib, { type Channel, type Connection } from 'amqplib';
import type { EventQueue, TraceEvent, TraceHandler } from './types.js';

const EXCHANGE = 'arachne.traces';
const QUEUE = 'arachne.traces.persist';
const DLX = 'arachne.traces.dlx';
const DLQ = 'arachne.traces.dlq';
const ROUTING_KEY = 'trace.created';

export class RabbitMQQueue implements EventQueue {
  private conn!: Connection;
  private pubChannel!: Channel;
  private subChannel?: Channel;

  private readonly url =
    process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

  async connect(): Promise<void> {
    this.conn = await amqplib.connect(this.url);

    this.pubChannel = await this.conn.createConfirmChannel();

    // Declare topology
    await this.pubChannel.assertExchange(DLX, 'direct', { durable: true });
    await this.pubChannel.assertQueue(DLQ, { durable: true });
    await this.pubChannel.bindQueue(DLQ, DLX, ROUTING_KEY);

    await this.pubChannel.assertExchange(EXCHANGE, 'direct', { durable: true });
    await this.pubChannel.assertQueue(QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DLX,
        'x-dead-letter-routing-key': ROUTING_KEY,
      },
    });
    await this.pubChannel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  }

  async publish(event: TraceEvent): Promise<void> {
    const body = Buffer.from(JSON.stringify(event));
    this.pubChannel.publish(EXCHANGE, ROUTING_KEY, body, {
      persistent: true,     // survives broker restart
      messageId: event.id,
      timestamp: event.timestamp,
      contentType: 'application/json',
    });
    // Publisher confirms ensure the broker has accepted the message.
    // waitForConfirms() batches under the hood; typical latency ~0.5ms.
    await this.pubChannel.waitForConfirms();
  }

  async subscribe(handler: TraceHandler): Promise<void> {
    this.subChannel = await this.conn.createChannel();
    await this.subChannel.prefetch(10);

    await this.subChannel.consume(QUEUE, async (msg) => {
      if (!msg) return;

      const event: TraceEvent = JSON.parse(msg.content.toString());
      const attempt = (msg.properties.headers?.['x-death']?.[0]?.count ?? 0) + 1;

      try {
        await handler(event);
        this.subChannel!.ack(msg);
      } catch (err) {
        console.error(`[rabbitmq] Handler failed (attempt ${attempt}):`, err);
        if (attempt >= 5) {
          // Exhausted retries — send to DLQ via reject(requeue=false)
          this.subChannel!.reject(msg, false);
        } else {
          // Requeue for retry
          this.subChannel!.nack(msg, false, true);
        }
      }
    });
  }

  async close(): Promise<void> {
    await this.subChannel?.close();
    await this.pubChannel?.close();
    await this.conn?.close();
  }
}
```

### b. Consumer/Worker Code Sample

```typescript
// src/worker.ts — same entrypoint pattern as BullMQ

import { createQueue } from './queue/index.js';
import { initOrm } from './orm.js';
import { encryptTraceBody } from './encryption.js';
import { Trace } from './domain/entities/Trace.js';
import { Tenant } from './domain/entities/Tenant.js';
import { Agent } from './domain/entities/Agent.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from './queue/types.js';

async function main() {
  const orm = await initOrm();
  const em = orm.em;
  const queue = createQueue(); // QUEUE_DRIVER=rabbitmq
  await queue.connect();

  await queue.subscribe(async (event: TraceEvent) => {
    const { payload: input } = event;
    const forkedEm = em.fork();

    // Same trace persistence logic as BullMQ worker (see section 1b)
    const reqBodyJson = JSON.stringify(input.requestBody);
    const { ciphertext: reqCt, iv: reqIv } = encryptTraceBody(input.tenantId, reqBodyJson);

    let resCt: string | null = null;
    let resIv: string | null = null;
    if (input.responseBody != null) {
      const enc = encryptTraceBody(input.tenantId, JSON.stringify(input.responseBody));
      resCt = enc.ciphertext;
      resIv = enc.iv;
    }

    const trace = new Trace();
    trace.id = event.id;
    trace.tenant = forkedEm.getReference(Tenant, input.tenantId);
    trace.agent = input.agentId ? forkedEm.getReference(Agent, input.agentId) : null;
    trace.requestId = input.requestId ?? randomUUID();
    trace.model = input.model;
    trace.provider = input.provider;
    trace.endpoint = input.endpoint ?? '/v1/chat/completions';
    trace.requestBody = reqCt;
    trace.requestIv = reqIv;
    trace.responseBody = resCt;
    trace.responseIv = resIv;
    trace.latencyMs = input.latencyMs;
    trace.promptTokens = input.promptTokens ?? null;
    trace.completionTokens = input.completionTokens ?? null;
    trace.totalTokens = input.totalTokens ?? null;
    trace.estimatedCostUsd = null;
    trace.encryptionKeyVersion = 1;
    trace.statusCode = input.statusCode ?? null;
    trace.ttfbMs = input.ttfbMs ?? null;
    trace.gatewayOverheadMs = input.gatewayOverheadMs ?? null;
    trace.createdAt = new Date(event.timestamp);
    trace.knowledgeBaseId = input.knowledgeBaseId ?? null;
    trace.embeddingAgentId = input.embeddingAgentId ?? null;
    trace.ragRetrievalLatencyMs = input.ragRetrievalLatencyMs ?? null;
    trace.embeddingLatencyMs = input.embeddingLatencyMs ?? null;
    trace.vectorSearchLatencyMs = input.vectorSearchLatencyMs ?? null;
    trace.retrievedChunkCount = input.retrievedChunkCount ?? null;
    trace.topChunkSimilarity = input.topChunkSimilarity ?? null;
    trace.avgChunkSimilarity = input.avgChunkSimilarity ?? null;
    trace.contextTokensAdded = input.contextTokensAdded ?? null;
    trace.ragOverheadTokens = input.ragOverheadTokens ?? null;
    trace.ragCostOverheadUsd = input.ragCostOverheadUsd ?? null;
    trace.ragStageFailed = input.ragStageFailed ?? null;
    trace.fallbackToNoRag = input.fallbackToNoRag ?? null;

    forkedEm.persist(trace);
    await forkedEm.flush();
  });

  console.log('[worker] Listening for trace events...');
}

main().catch((err) => {
  console.error('[worker] Fatal:', err);
  process.exit(1);
});
```

### c. Desktop In-Memory Adapter

Same `InMemoryQueue` from section 1c. RabbitMQ has no embeddable mode for Node.js.

### d. Docker Compose Addition

```yaml
  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "5672:5672"    # AMQP
      - "15672:15672"  # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: arachne
      RABBITMQ_DEFAULT_PASS: arachne_dev
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "check_running"]
      interval: 10s
      timeout: 5s
      retries: 5

  trace-worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: node dist/worker.js
    depends_on:
      rabbitmq:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://loom:loom_dev_password@postgres:5432/loom
      QUEUE_DRIVER: rabbitmq
      RABBITMQ_URL: amqp://arachne:arachne_dev@rabbitmq:5672
      ENCRYPTION_MASTER_KEY: "0000000000000000000000000000000000000000000000000000000000000001"

# Add to volumes:
  rabbitmq_data:
```

### e. Error Handling

Retry is handled via nack/requeue (see consumer code above). The `x-death` header tracks retry count. After 5 failures, the message is rejected and routed to the DLQ via the dead-letter exchange.

For more sophisticated retry with delays, use RabbitMQ's delayed message exchange plugin or a TTL-based retry pattern with intermediate queues:

```typescript
// TTL retry queue pattern (per-attempt delay escalation)
// Queue: arachne.traces.retry.1 (TTL: 1s)  → re-routes to main exchange
// Queue: arachne.traces.retry.2 (TTL: 5s)  → re-routes to main exchange
// Queue: arachne.traces.retry.3 (TTL: 30s) → re-routes to main exchange
// Adds significant topology complexity compared to BullMQ's built-in backoff.
```

**When the worker is down:** RabbitMQ persists durable messages to disk. Messages accumulate until the worker reconnects. Memory and disk alarms trigger flow control (backpressure to publishers) when thresholds are exceeded. Default disk free limit is 50 MB.

### f. Agent Team Readiness

RabbitMQ is a message broker, not a workflow engine. Saga orchestration would require:
- Custom state tracking in a database
- Correlation IDs to link related messages
- Timeout management via delayed messages or external schedulers
- Compensation logic wired through additional exchanges/queues

Some libraries (e.g., NServiceBus for .NET) provide saga support on top of RabbitMQ, but there is no equivalent mature library for Node.js/TypeScript.

**Verdict:** Strong as a message broker, but adds no value for saga orchestration. Similar to BullMQ in requiring custom workflow code.

---

## 4. Azure Service Bus

**npm:** `@azure/service-bus`
**Requires:** Azure subscription (managed) or Azure Service Bus Emulator (local dev)

### a. Producer Code Sample

```typescript
// src/queue/azuresb.ts

import {
  ServiceBusClient,
  type ServiceBusSender,
  type ServiceBusReceiver,
  type ProcessErrorArgs,
} from '@azure/service-bus';
import type { EventQueue, TraceEvent, TraceHandler } from './types.js';

const QUEUE_NAME = 'arachne-traces';

export class AzureServiceBusQueue implements EventQueue {
  private client!: ServiceBusClient;
  private sender!: ServiceBusSender;
  private receiver?: ServiceBusReceiver;

  private readonly connectionString =
    process.env.AZURE_SERVICEBUS_CONNECTION_STRING ?? '';

  async connect(): Promise<void> {
    this.client = new ServiceBusClient(this.connectionString);
    this.sender = this.client.createSender(QUEUE_NAME);
  }

  async publish(event: TraceEvent): Promise<void> {
    await this.sender.sendMessages({
      body: event,
      messageId: event.id,
      contentType: 'application/json',
      subject: 'trace.created',
      applicationProperties: {
        tenantId: event.payload.tenantId,
      },
    });
  }

  async subscribe(handler: TraceHandler): Promise<void> {
    this.receiver = this.client.createReceiver(QUEUE_NAME, {
      receiveMode: 'peekLock',
    });

    this.receiver.subscribe({
      processMessage: async (message) => {
        const event = message.body as TraceEvent;
        await handler(event);
        // Auto-completed on success when using subscribe()
      },
      processError: async (args: ProcessErrorArgs) => {
        console.error(
          `[azuresb] Error from ${args.errorSource}: ${args.error.message}`,
        );
      },
    }, {
      maxConcurrentCalls: 10,
      autoCompleteMessages: true,
    });
  }

  async close(): Promise<void> {
    await this.receiver?.close();
    await this.sender?.close();
    await this.client?.close();
  }
}
```

### b. Consumer/Worker Code Sample

```typescript
// src/worker.ts — identical entrypoint pattern

import { createQueue } from './queue/index.js';
import { initOrm } from './orm.js';
import { encryptTraceBody } from './encryption.js';
import { Trace } from './domain/entities/Trace.js';
import { Tenant } from './domain/entities/Tenant.js';
import { Agent } from './domain/entities/Agent.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from './queue/types.js';

async function main() {
  const orm = await initOrm();
  const em = orm.em;
  const queue = createQueue(); // QUEUE_DRIVER=azuresb
  await queue.connect();

  await queue.subscribe(async (event: TraceEvent) => {
    // Same trace persistence logic as other workers (see section 1b)
    const { payload: input } = event;
    const forkedEm = em.fork();

    const reqBodyJson = JSON.stringify(input.requestBody);
    const { ciphertext: reqCt, iv: reqIv } = encryptTraceBody(input.tenantId, reqBodyJson);

    let resCt: string | null = null;
    let resIv: string | null = null;
    if (input.responseBody != null) {
      const enc = encryptTraceBody(input.tenantId, JSON.stringify(input.responseBody));
      resCt = enc.ciphertext;
      resIv = enc.iv;
    }

    const trace = new Trace();
    trace.id = event.id;
    trace.tenant = forkedEm.getReference(Tenant, input.tenantId);
    trace.agent = input.agentId ? forkedEm.getReference(Agent, input.agentId) : null;
    trace.requestId = input.requestId ?? randomUUID();
    trace.model = input.model;
    trace.provider = input.provider;
    trace.endpoint = input.endpoint ?? '/v1/chat/completions';
    trace.requestBody = reqCt;
    trace.requestIv = reqIv;
    trace.responseBody = resCt;
    trace.responseIv = resIv;
    trace.latencyMs = input.latencyMs;
    trace.promptTokens = input.promptTokens ?? null;
    trace.completionTokens = input.completionTokens ?? null;
    trace.totalTokens = input.totalTokens ?? null;
    trace.estimatedCostUsd = null;
    trace.encryptionKeyVersion = 1;
    trace.statusCode = input.statusCode ?? null;
    trace.ttfbMs = input.ttfbMs ?? null;
    trace.gatewayOverheadMs = input.gatewayOverheadMs ?? null;
    trace.createdAt = new Date(event.timestamp);
    trace.knowledgeBaseId = input.knowledgeBaseId ?? null;
    trace.embeddingAgentId = input.embeddingAgentId ?? null;
    trace.ragRetrievalLatencyMs = input.ragRetrievalLatencyMs ?? null;
    trace.embeddingLatencyMs = input.embeddingLatencyMs ?? null;
    trace.vectorSearchLatencyMs = input.vectorSearchLatencyMs ?? null;
    trace.retrievedChunkCount = input.retrievedChunkCount ?? null;
    trace.topChunkSimilarity = input.topChunkSimilarity ?? null;
    trace.avgChunkSimilarity = input.avgChunkSimilarity ?? null;
    trace.contextTokensAdded = input.contextTokensAdded ?? null;
    trace.ragOverheadTokens = input.ragOverheadTokens ?? null;
    trace.ragCostOverheadUsd = input.ragCostOverheadUsd ?? null;
    trace.ragStageFailed = input.ragStageFailed ?? null;
    trace.fallbackToNoRag = input.fallbackToNoRag ?? null;

    forkedEm.persist(trace);
    await forkedEm.flush();
  });

  console.log('[worker] Listening for trace events...');
}

main().catch((err) => {
  console.error('[worker] Fatal:', err);
  process.exit(1);
});
```

### c. Desktop In-Memory Adapter

Same `InMemoryQueue` from section 1c. The Azure Service Bus Emulator exists but requires Docker and the Azure CLI, making it unsuitable for a zero-dependency desktop mode.

### d. Docker Compose Addition

```yaml
  # Azure Service Bus Emulator (local development only)
  azurite-servicebus:
    image: mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
    ports:
      - "5672:5672"
    environment:
      ACCEPT_EULA: "Y"
      SQL_SERVER: mssql
    depends_on:
      mssql:
        condition: service_healthy

  # The emulator requires SQL Server for state
  mssql:
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "Str0ngP@ssw0rd!"
    healthcheck:
      test: /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P "Str0ngP@ssw0rd!" -Q "SELECT 1"
      interval: 10s
      timeout: 5s
      retries: 5

  trace-worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: node dist/worker.js
    depends_on:
      azurite-servicebus:
        condition: service_started
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://loom:loom_dev_password@postgres:5432/loom
      QUEUE_DRIVER: azuresb
      AZURE_SERVICEBUS_CONNECTION_STRING: "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;"
      ENCRYPTION_MASTER_KEY: "0000000000000000000000000000000000000000000000000000000000000001"
```

### e. Error Handling

Azure Service Bus handles retries via its peek-lock mechanism. If `processMessage` throws, the message lock expires and Service Bus redelivers it. After `maxDeliveryCount` (default: 10) failures, the message moves to the built-in dead-letter sub-queue.

```typescript
// Configure via Azure portal / CLI / Bicep:
// Queue properties:
//   maxDeliveryCount: 5
//   lockDuration: PT30S (30 seconds)
//   deadLetteringOnMessageExpiration: true

// Reading from DLQ:
const dlqReceiver = client.createReceiver(QUEUE_NAME, {
  subQueueType: 'deadLetter',
});

const deadLetters = await dlqReceiver.receiveMessages(10, {
  maxWaitTimeInMs: 5_000,
});

for (const msg of deadLetters) {
  console.log('Dead letter reason:', msg.deadLetterReason);
  console.log('Dead letter description:', msg.deadLetterErrorDescription);
  // Reprocess or log
  await dlqReceiver.completeMessage(msg);
}
```

**When the worker is down:** Messages accumulate in the queue. Azure Service Bus has configurable max queue size (1-80 GB in Standard/Premium tiers). No risk of data loss. Messages are persisted to Azure-managed storage.

### f. Agent Team Readiness

Azure Service Bus provides sessions (ordered message groups keyed by session ID), which can serve as a building block for saga coordination. Each agent team execution could use a unique session ID to ensure ordered processing. However, there is no built-in saga or workflow engine — orchestration logic would still need to be custom.

Azure Durable Functions (built on Azure Storage) provides saga/workflow support, but that ties the project to Azure Functions as a compute platform, which conflicts with Arachne's self-hosted model.

**Verdict:** Sessions are a useful primitive, but saga support would require significant custom code. Vendor lock-in to Azure is the main concern.

---

## Comparison Matrix

| Dimension | BullMQ | Temporal | RabbitMQ | Azure Service Bus |
|---|---|---|---|---|
| **New dependencies** | Redis | Temporal server | RabbitMQ server | Azure subscription or emulator + MSSQL |
| **Docker image size** | ~30 MB (Redis Alpine) | ~200 MB (Temporal + UI) | ~150 MB (RabbitMQ + mgmt) | ~700 MB (emulator + MSSQL) |
| **npm packages** | 1 (`bullmq`) | 4 (`@temporalio/*`) | 1 (`amqplib`) | 1 (`@azure/service-bus`) |
| **Adapter code (LoC)** | ~60 | ~100 (+ workflow file) | ~90 | ~60 |
| **Publish latency** | < 1ms (Redis XADD) | ~2-5ms (gRPC to Temporal) | < 1ms (AMQP publish) | ~5-15ms (HTTPS to Azure) |
| **Retry/backoff** | Built-in, configurable | Built-in, declarative | Manual (nack/requeue) | Built-in (peek-lock) |
| **DLQ** | Built-in (failed set) | N/A (failed workflows) | Manual setup (DLX) | Built-in sub-queue |
| **Admin UI** | Bull Board (npm add-on) | Temporal UI (excellent) | RabbitMQ Management (built-in) | Azure Portal |
| **SDK quality (TS)** | Excellent (TS-first) | Excellent (TS-first) | Adequate (callback-based) | Good (Azure SDK) |
| **Desktop in-memory** | Needs InMemoryQueue | Needs InMemoryQueue | Needs InMemoryQueue | Needs InMemoryQueue |
| **Saga/workflow** | No (FlowProducer is limited) | Yes (purpose-built) | No | No (sessions help, not enough) |
| **Operational complexity** | Low (Redis is well-known) | Medium-High (new server) | Medium (Erlang runtime) | Low (managed) / High (emulator) |
| **Cost (self-hosted)** | Free | Free | Free | ~$0.05/million ops (Standard) |
| **Community/ecosystem** | Large (npm 1M+/week) | Growing (npm ~100k/week) | Very large (AMQP standard) | Large (Azure ecosystem) |

## Recommendation

**Phase 1 (now): BullMQ**

For the immediate need of durable trace recording, BullMQ is the clear winner on benefit-to-cost ratio:

1. **Minimal infrastructure** — Redis is a single 30 MB container that most teams already run. No new runtime to learn.
2. **Sub-millisecond publish** — Meets the < 1ms hot-path budget with room to spare. Redis Streams (XADD) is as fast as in-memory operations get for durable writes.
3. **Batteries included** — Retry with exponential backoff, DLQ, rate limiting, priority queues, and Bull Board UI all work out of the box. No topology to design (unlike RabbitMQ's exchanges) and no retry queue hacks.
4. **TypeScript-first SDK** — Single package, clean API, well-maintained, massive adoption.
5. **Small team friendly** — One `docker compose up` and it works. No Erlang runtime, no gRPC servers, no Azure subscriptions.

**Phase 2 (when agent teams ship): Evaluate Temporal**

When multi-agent coordination requires saga/workflow orchestration, Temporal becomes worth its operational cost. At that point:

- The `EventQueue` interface means BullMQ can remain the trace queue backend.
- Temporal is introduced specifically for agent team workflows (coordinator dispatch, partial failure compensation, timeout management).
- The two systems coexist: BullMQ for high-throughput fire-and-forget events, Temporal for complex stateful orchestration.

**Why not the others:**

- **RabbitMQ** — Solves the same problem as BullMQ but with more operational complexity (Erlang runtime, exchange topology design, manual DLQ wiring). The AMQP protocol flexibility is not needed here.
- **Azure Service Bus** — Creates cloud vendor lock-in. The emulator requires MSSQL, which is absurd for a PostgreSQL-native project. Only makes sense if Arachne moves to Azure-managed infrastructure.
- **Temporal now** — Overengineered for "put trace event in queue, write to database." The 4-package SDK, separate server process, and workflow determinism constraints add complexity that is not justified until we need actual workflow orchestration.

### Migration Path

```
Phase 1: TraceRecorder (in-memory)     →  BullMQ (Redis)
         └── QUEUE_DRIVER=memory            └── QUEUE_DRIVER=bullmq
             (Desktop mode keeps this)          (Server mode)

Phase 2: Agent team orchestration       →  Temporal (alongside BullMQ)
         └── New workflow engine              └── Trace queue stays on BullMQ
             for saga coordination                (high throughput, simple)
```

### Implementation Estimate

| Task | Effort |
|---|---|
| Define `EventQueue` interface + factory | 1 hour |
| `InMemoryQueue` adapter (replaces TraceRecorder) | 2 hours |
| `BullMQQueue` adapter | 2 hours |
| Worker entrypoint (`src/worker.ts`) | 2 hours |
| Extract trace persistence into shared function | 1 hour |
| Docker Compose (Redis + worker) | 30 min |
| Update gateway to use `queue.publish()` | 1 hour |
| Tests (adapter unit + integration) | 3 hours |
| **Total** | **~1.5 days** |
