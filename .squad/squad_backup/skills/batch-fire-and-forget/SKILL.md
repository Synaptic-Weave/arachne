# Skill: Batch Fire-and-Forget Writer

**Context:** Server-side workloads where you need to persist telemetry/audit data
from the hot request path without adding latency or risking gateway crashes.

## Pattern

```typescript
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5_000;

class BatchWriter<T> {
  private batch: T[] = [];
  private timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);

  constructor() {
    // Prevent the interval from blocking process exit in tests.
    this.timer.unref?.();
  }

  /** Enqueue an item. Never throws. */
  enqueue(item: T): void {
    try {
      this.batch.push(item);
      if (this.batch.length >= BATCH_SIZE) void this.flush();
    } catch { /* never crash caller */ }
  }

  async flush(): Promise<void> {
    if (!this.batch.length) return;
    const rows = this.batch.splice(0); // atomic swap
    try {
      await writeToDB(rows);
    } catch { /* swallow — caller stability > data completeness */ }
  }

  stop() { clearInterval(this.timer); }
}
```

## Key Design Points

1. **`batch.splice(0)`** — atomically swaps the array; items arriving during an async flush go into the new empty batch, not lost.
2. **`timer.unref()`** — lets Node exit cleanly even if the timer is still pending (critical for test runners like vitest).
3. **Double try/catch** — outer in `enqueue()` guards encryption/prep work; inner in `flush()` guards DB writes. Neither propagates.
4. **Fire-and-forget call site** — callers call `enqueue()` (sync) and never await `flush()`. The request path returns immediately.

## When to Use

- Trace/audit recording on the hot path
- Metrics/event collection
- Any "best-effort write" where a failure is preferable to a crash

## Anti-Patterns

- **Awaiting flush in the request handler** — defeats the purpose; adds DB latency to every request.
- **Using a fixed-size array with index tracking** — race conditions; `splice(0)` is simpler and correct.
- **Retrying failed batches** — Phase 1 drops failures silently; add a dead-letter queue in Phase 2 if needed.
