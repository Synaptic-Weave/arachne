# Agent Scheduling

> Tracked by Epic [#TBD]

## Status

Draft -- MVP Specification

## Overview

Enable agents (and agent teams) to execute on a cron schedule. Two modes
are supported: gateway-initiated (Arachne sends a configured prompt to
the LLM on schedule) and webhook (Arachne fires an HTTP callback for
external systems to handle).

------------------------------------------------------------------------

## Design Goals

1. **Declarative:** schedules are defined in agent or team YAML specs.
2. **Two modes:** gateway-initiated for self-contained agents, webhook
   for external orchestration.
3. **Observable:** scheduled executions produce traces like normal
   requests.
4. **Reliable:** configurable retry policy with exponential backoff.
5. **Desktop-friendly:** in-process scheduler with no external
   dependencies (no Redis, no message broker).
6. **Tenant-scoped:** all schedules are isolated per tenant.

------------------------------------------------------------------------

## Spec Format

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: daily-report-agent
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    Generate a daily summary report.
  schedule:
    cron: "0 9 * * 1-5"
    timezone: "America/New_York"
    mode: gateway
    prompt: |
      Generate today's summary report for the following metrics...
    enabled: true
    retryPolicy:
      maxRetries: 3
      backoffMs: 5000
```

### Schedule Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `cron` | string | yes | (none) | Standard cron expression (5 fields) |
| `timezone` | string | no | `UTC` | IANA timezone identifier |
| `mode` | enum | yes | (none) | `gateway` or `webhook` |
| `prompt` | string | gateway only | (none) | The prompt sent to the LLM on each tick |
| `webhookUrl` | string | webhook only | (none) | URL to POST on each tick |
| `webhookHeaders` | object | no | (none) | Additional headers for webhook requests |
| `enabled` | boolean | no | `true` | Whether the schedule is active |
| `retryPolicy.maxRetries` | number | no | `3` | Maximum retry attempts on failure |
| `retryPolicy.backoffMs` | number | no | `5000` | Initial backoff interval in milliseconds |

### AgentTeam Schedules

Teams can also have schedules. The team's coordination pattern runs on
each trigger:

```yaml
apiVersion: arachne-ai.com/v0
kind: AgentTeam
metadata:
  name: nightly-analysis-team
spec:
  coordination: handoff
  schedule:
    cron: "0 2 * * *"
    timezone: "UTC"
    mode: gateway
    prompt: "Run the nightly analysis pipeline."
```

### Validation Rules

- `cron` must be a valid 5-field cron expression. Extended (6-field with
  seconds) is not supported.
- `timezone` must be a valid IANA timezone (validated at weave time).
- Gateway mode requires `prompt`; webhook mode requires `webhookUrl`.
- `retryPolicy.maxRetries` must be between 0 and 10.
- `retryPolicy.backoffMs` must be between 1000 and 300000 (1 second to
  5 minutes).

------------------------------------------------------------------------

## Schedule Entity

```typescript
class Schedule {
  id: string;                                           // UUIDv4
  tenantId: string;
  agentId: string;
  artifactKind: 'Agent' | 'AgentTeam';
  deploymentId: string;
  cron: string;
  timezone: string;
  mode: 'gateway' | 'webhook';
  prompt: string | null;
  webhookUrl: string | null;
  webhookHeaders: Record<string, string> | null;
  enabled: boolean;
  retryPolicy: { maxRetries: number; backoffMs: number };
  lastRunAt: Date | null;
  nextRunAt: Date;
  status: 'idle' | 'running' | 'error';
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### Migration

```sql
CREATE TABLE schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('Agent', 'AgentTeam')),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  cron          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  mode          TEXT NOT NULL CHECK (mode IN ('gateway', 'webhook')),
  prompt        TEXT,
  webhook_url   TEXT,
  webhook_headers JSONB,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  retry_policy  JSONB NOT NULL DEFAULT '{"maxRetries": 3, "backoffMs": 5000}',
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedules_tenant ON schedules(tenant_id);
CREATE INDEX idx_schedules_next_run ON schedules(next_run_at) WHERE enabled = TRUE;
CREATE INDEX idx_schedules_deployment ON schedules(deployment_id);
```

The down migration drops the table:

```sql
DROP TABLE schedules;
```

### EntitySchema

```typescript
export const ScheduleSchema = new EntitySchema<Schedule>({
  class: Schedule,
  tableName: 'schedules',
  properties: {
    id:              { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    tenantId:        { type: 'uuid', fieldName: 'tenant_id' },
    agentId:         { type: 'uuid', fieldName: 'agent_id' },
    artifactKind:    { type: 'string', fieldName: 'artifact_kind' },
    deploymentId:    { type: 'uuid', fieldName: 'deployment_id' },
    cron:            { type: 'string' },
    timezone:        { type: 'string', default: 'UTC' },
    mode:            { type: 'string' },
    prompt:          { type: 'string', nullable: true },
    webhookUrl:      { type: 'string', nullable: true, fieldName: 'webhook_url' },
    webhookHeaders:  { type: 'json', nullable: true, fieldName: 'webhook_headers' },
    enabled:         { type: 'boolean', default: true },
    retryPolicy:     { type: 'json', fieldName: 'retry_policy' },
    lastRunAt:       { type: 'datetime', nullable: true, fieldName: 'last_run_at' },
    nextRunAt:       { type: 'datetime', fieldName: 'next_run_at' },
    status:          { type: 'string', default: 'idle' },
    lastError:       { type: 'string', nullable: true, fieldName: 'last_error' },
    createdAt:       { type: 'datetime', fieldName: 'created_at' },
    updatedAt:       { type: 'datetime', fieldName: 'updated_at' },
  },
});
```

------------------------------------------------------------------------

## Scheduler Engine

### Architecture

The scheduler runs in-process using a cron timer library (e.g.,
`croner`). It lives within the Arachne gateway process and requires no
external infrastructure.

```
src/scheduling/
  Scheduler.ts          # Timer management and lifecycle
  ScheduleExecutor.ts   # Execution logic (gateway and webhook modes)
  ScheduleService.ts    # CRUD operations and DB persistence
```

### Scheduler Class

```typescript
// src/scheduling/Scheduler.ts
class Scheduler {
  private timers: Map<string, CronJob>;
  private running: Map<string, Promise<void>>;

  async start(): Promise<void>        // Load enabled schedules, register timers
  register(schedule: Schedule): void  // Create and start a cron timer
  unregister(scheduleId: string): void // Cancel timer, remove from maps
  async shutdown(): Promise<void>     // Cancel all timers, await running executions
}
```

The `Scheduler` is instantiated during server startup and shut down
gracefully on `SIGTERM` / `SIGINT`.

### Gateway-Mode Execution

On cron tick:

1. Check the concurrency guard (skip if already running).
2. Set `status: 'running'` on the schedule row.
3. Construct a synthetic chat completion request:
   - `messages: [{ role: 'user', content: schedule.prompt }]`
   - Model resolved from the agent's deployment config.
   - No external API key needed (internal service call).
4. Route through the existing pipeline (conversation memory, RAG
   injection, agent application, provider proxy).
5. Record the response as a trace with `scheduleId` for correlation.
6. On success: set `status: 'idle'`, update `lastRunAt`, compute
   `nextRunAt`.
7. On failure: retry per policy. After exhaustion, set `status: 'error'`
   and `lastError`.

### Webhook-Mode Execution

On cron tick:

1. Check the concurrency guard (skip if already running).
2. Set `status: 'running'` on the schedule row.
3. Fire an HTTP POST to `webhookUrl` with body:

```json
{
  "scheduleId": "a1b2c3d4-...",
  "agentId": "e5f6a7b8-...",
  "tenantId": "c9d0e1f2-...",
  "triggeredAt": "2026-03-21T09:00:00Z",
  "cron": "0 9 * * 1-5"
}
```

4. Include any configured `webhookHeaders` plus an HMAC signature header
   (see Security Considerations).
5. On 2xx response: set `status: 'idle'`, record trace, update
   `lastRunAt`.
6. On non-2xx or network error: retry per policy (exponential backoff).
   After exhaustion, set `status: 'error'` and `lastError`.

### Retry Policy

Retries use exponential backoff: delay = `backoffMs * 2^attempt`.

Example with defaults (`maxRetries: 3`, `backoffMs: 5000`):

| Attempt | Delay |
|---------|-------|
| 1 | 5 seconds |
| 2 | 10 seconds |
| 3 | 20 seconds |

After all retries are exhausted the schedule enters `status: 'error'`
with the last error message stored in `lastError`. The schedule remains
registered and will fire again at the next cron tick (the error status
does not disable it).

### Concurrency Guard

If a scheduled execution is still running when the next cron tick fires,
the tick is skipped. Only one execution per schedule runs at a time.
Skipped ticks are logged and produce a `schedule.skipped` event for
observability.

------------------------------------------------------------------------

## Deployment Integration

### Deploy Flow

When an agent or team with `spec.schedule` is deployed:

1. Parse and validate the schedule configuration from the spec.
2. Create or update a `Schedule` row in the database, linked to the
   deployment.
3. Compute `nextRunAt` from the cron expression and timezone.
4. Register the schedule with the in-process `Scheduler`.

### Teardown Flow

When a deployment is torn down:

1. Unregister the schedule from the `Scheduler` (cancel the timer).
2. If an execution is in progress, await its completion (graceful
   drain).
3. Delete the `Schedule` row from the database.

### Redeployment

When a deployment is updated (e.g., new version pushed):

1. Unregister the old schedule.
2. Create or update the `Schedule` row with the new configuration.
3. Register the updated schedule.

------------------------------------------------------------------------

## REST API

All endpoints require tenant API key authentication.

```
GET    /v1/schedules                  # List schedules for tenant
GET    /v1/schedules/:id              # Get schedule details
PATCH  /v1/schedules/:id              # Update schedule (enable/disable, change cron)
POST   /v1/schedules/:id/trigger      # Manual trigger (run immediately)
```

### GET /v1/schedules

Returns all schedules for the authenticated tenant. Supports pagination
via `limit` and `offset` query parameters.

Response:

```json
{
  "schedules": [
    {
      "id": "a1b2c3d4-...",
      "agentId": "e5f6a7b8-...",
      "artifactKind": "Agent",
      "cron": "0 9 * * 1-5",
      "timezone": "America/New_York",
      "mode": "gateway",
      "enabled": true,
      "status": "idle",
      "lastRunAt": "2026-03-20T14:00:00Z",
      "nextRunAt": "2026-03-21T14:00:00Z"
    }
  ],
  "total": 1
}
```

### PATCH /v1/schedules/:id

Updatable fields: `enabled`, `cron`, `timezone`, `prompt`,
`webhookUrl`, `webhookHeaders`, `retryPolicy`.

Changing `cron` or `timezone` recomputes `nextRunAt` and re-registers
the timer.

### POST /v1/schedules/:id/trigger

Manually triggers a schedule execution immediately, regardless of the
cron expression. Returns `202 Accepted` with the execution's
`requestId`. The execution follows the same pipeline as a cron-triggered
run.

------------------------------------------------------------------------

## Tracing

Scheduled executions produce traces identical in structure to normal
requests, with additional fields for correlation:

| Field | Value |
|-------|-------|
| `requestId` | UUIDv4, generated at trigger time |
| `scheduleId` | Links to the Schedule entity |
| `agentId` / `teamId` | The executing agent or team |
| `principalId` | `null` (system-initiated, no end-user) |
| `triggerType` | `scheduled` (distinguishes from `api` requests) |

### Events

The following events are emitted via the internal EventBus:

| Event | When |
|-------|------|
| `schedule.triggered` | Cron tick fires (before execution) |
| `schedule.completed` | Execution finishes successfully |
| `schedule.failed` | Execution fails after all retries |
| `schedule.skipped` | Tick skipped due to concurrency guard |

Events include `scheduleId`, `agentId`, `tenantId`, and a timestamp.
They can be consumed by the tracing system, webhooks, or future
alerting integrations.

------------------------------------------------------------------------

## Multi-Replica Considerations

The in-process scheduler means each replica runs its own timer loop. In
a single-replica deployment (the default for Phase 1) this is not a
problem. For multi-replica production deployments, duplicate execution
must be prevented.

### Option A: Designated Scheduler Replica (MVP)

Enable scheduling on exactly one replica via environment variable:

```
SCHEDULER_ENABLED=true   # Only set on one replica
```

Other replicas skip scheduler initialization entirely. This is simple
and sufficient for early production use.

### Option B: Database-Based Leader Election (Phase 2)

Use an advisory lock or lease table so that only one replica holds the
scheduler lock at a time. If the leader crashes, another replica
acquires the lock after a configurable timeout.

### Option C: Queue-Based Scheduling (Phase 3)

Move to a distributed job queue (e.g., BullMQ with Redis) for
horizontal scaling. Configure via:

```
SCHEDULER_MODE=internal    # In-process (default)
SCHEDULER_MODE=bullmq      # Distributed via BullMQ
```

The `Scheduler` interface remains the same; only the backend changes.

------------------------------------------------------------------------

## Security Considerations

- **Gateway mode** uses internal service calls routed through the
  existing pipeline. No external API keys are exposed in the schedule
  configuration (the agent's deployment config provides provider
  credentials).
- **Webhook URLs** are validated at deploy time. In production
  (`NODE_ENV=production`), only HTTPS URLs are accepted.
- **Webhook HMAC signature:** each webhook request includes an
  `X-Arachne-Signature` header containing an HMAC-SHA256 digest of the
  request body, keyed with a per-tenant derived secret. Recipients can
  verify authenticity by recomputing the signature.
- **Schedule modifications** require tenant API key authentication.
  Schedules can only be modified by the tenant that owns them.
- **Prompt injection:** the `schedule.prompt` field is treated as
  trusted input (it is authored by the tenant, not by end-users). No
  additional sanitization is applied beyond standard input validation.

------------------------------------------------------------------------

## CLI Integration

### Weave Validation

`arachne weave` validates the `schedule` block when present:

- Cron expression syntax check.
- Timezone validity check (against IANA database).
- Mode-specific field presence (prompt for gateway, webhookUrl for
  webhook).
- Retry policy bounds check.

Validation errors are reported inline with other spec errors.

### Deploy Output

`arachne deploy` reports schedule registration:

```
Deploying daily-report-agent to staging...
  Schedule registered: "0 9 * * 1-5" (America/New_York)
  Next run: 2026-03-22T09:00:00-04:00
Done.
```

------------------------------------------------------------------------

## Future Extensions

- **Visual schedule builder:** drag-and-drop schedule configuration in
  the Portal UI.
- **Schedule history:** paginated execution log with status, duration,
  and error details.
- **Schedule dependencies:** run schedule B after schedule A completes
  successfully.
- **Event-triggered schedules:** fire on external events (webhooks
  received, KB updates) in addition to cron.
- **Distributed scheduling with leader election:** automatic failover
  without manual replica designation.
- **Alerting integration:** notify via email or Slack when a schedule
  enters error state.
