# Agent Messaging & Dynamic Channels

> Tracked by Epic [#TBD]

**Status:** Draft
**Author:** Arachne Team
**Last Updated:** 2026-03-21

---

## 1. Overview

The agent messaging system extends Arachne's existing `EventBus` interface (defined in the [observability architecture spec](observability_architecture.md), section 5.1) with durable agent-to-agent messaging and named channel abstractions. The bus becomes dual-purpose: fire-and-forget observability events alongside at-least-once agent messages.

Observability events and agent messages have fundamentally different delivery requirements. Observability events are lossy by design (dropped events degrade dashboards but never break agents). Agent messages are durable (a lost message can break a multi-agent workflow). This spec introduces a dedicated `AgentBus` layer that sits alongside the `EventBus`, sharing infrastructure but maintaining separate delivery guarantees and queue topics.

---

## 2. Design Goals

1. **Extend, not replace** the existing `EventBus` from the observability spec. Observability event emission (`emit()`) remains unchanged.
2. **Separate delivery guarantees**: lossy for observability events, durable (at-least-once) for agent messages.
3. **Separate queue topic**: agent messages use a dedicated queue topic to prevent backpressure from high-volume trace events.
4. **Desktop mode works out of the box**: in-memory bus with zero external dependencies for local development and single-process deployments.
5. **Tenant-scoped**: all channels and messages are isolated per tenant. No cross-tenant message leakage.
6. **Gateway overhead target preserved**: messaging is off the hot path. The < 20ms gateway overhead budget (per CLAUDE.md) is not impacted because message dispatch happens after the response is sent or in background agent workflows.
7. **Declarative channel wiring**: agents declare channel subscriptions in their YAML specs, reducing runtime configuration.

---

## 3. Service Bus Extension

### 3.1 Core Types

```typescript
// src/bus/types.ts

import type { GatewayEvent } from '../events/types.js';

/**
 * Agent-to-agent message. Extends GatewayEvent so it can flow through
 * the same infrastructure, but carries additional routing fields.
 */
interface AgentMessage extends GatewayEvent {
  type: 'agent.message';

  /** Agent that sent this message. */
  sourceAgentId: string;

  /** For directed messages: the specific agent to receive this message. */
  targetAgentId?: string;

  /** For channel-based messages: the channel name to route through. */
  channel?: string;

  /** Message content following the standard chat role convention. */
  payload: {
    role: 'system' | 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  };

  /**
   * Links related messages in a multi-turn interaction.
   * All messages in a single agent-to-agent exchange share this ID.
   */
  correlationId: string;

  /**
   * When true, the bus guarantees at-least-once delivery.
   * When false, best-effort delivery (same as observability events).
   */
  durable: boolean;
}

/** Result of a send operation. */
interface SendReceipt {
  /** Unique ID assigned to the enqueued message. */
  messageId: string;

  /** Timestamp when the message was accepted by the bus. */
  enqueuedAt: number;
}

/** Callback invoked when an agent receives a message. */
type AgentMessageHandler = (message: AgentMessage) => Promise<void>;
```

### 3.2 Extended EventBus Interface

The `AgentBus` is a separate interface that complements (not extends) `EventBus`. This preserves backward compatibility: existing code that depends on `EventBus` is unaffected.

```typescript
// src/bus/agentBus.ts

import type { AgentMessage, AgentMessageHandler, SendReceipt } from './types.js';

/**
 * Agent messaging bus. Provides durable delivery for inter-agent
 * communication. Runs alongside the EventBus (which handles
 * fire-and-forget observability events).
 */
interface AgentBus {
  /**
   * Send a message to one or more agents.
   * Returns after the message has been durably enqueued (for durable messages)
   * or dispatched (for best-effort messages).
   *
   * Routing logic:
   * - If targetAgentId is set: direct delivery to that agent.
   * - If channel is set: delivery via the ChannelRouter (see section 4).
   * - If both are set: targetAgentId takes precedence.
   * - If neither is set: throws InvalidMessageError.
   */
  send(message: AgentMessage): Promise<SendReceipt>;

  /**
   * Register a handler for messages targeting a specific agent.
   * Only one handler per agentId is allowed; registering a second
   * handler for the same agentId replaces the previous one.
   */
  subscribe(agentId: string, handler: AgentMessageHandler): void;

  /**
   * Remove the handler for the given agentId.
   */
  unsubscribe(agentId: string): void;

  /**
   * Graceful shutdown: wait for in-flight messages to complete,
   * close connections.
   */
  shutdown(): Promise<void>;
}
```

The existing `EventBus.emit()` method remains unchanged (fire-and-forget, void return, swallows errors). The two interfaces coexist:

```typescript
// Usage at the application level
const eventBus: EventBus = createEventBus();     // observability
const agentBus: AgentBus = createAgentBus();      // inter-agent messaging

// Observability (lossy, non-blocking)
eventBus.emit({ type: 'request.received', ... });

// Agent messaging (durable, awaitable)
await agentBus.send({
  type: 'agent.message',
  sourceAgentId: 'classifier-agent',
  channel: 'classified-tickets',
  payload: { role: 'assistant', content: 'Ticket #42 classified as billing.' },
  correlationId: 'corr-abc-123',
  durable: true,
  requestId: currentRequestId,
  tenantId: tenant.id,
  timestamp: Date.now(),
});
```

### 3.3 InMemoryAgentBus

Desktop mode implementation for local development and single-process deployments. No external dependencies required.

```typescript
// src/bus/inMemoryAgentBus.ts

import { randomUUID } from 'node:crypto';
import type { AgentBus, AgentMessage, AgentMessageHandler, SendReceipt } from './types.js';

class InMemoryAgentBus implements AgentBus {
  private handlers = new Map<string, AgentMessageHandler>();
  private channelRouter: ChannelRouter;

  constructor(channelRouter: ChannelRouter) {
    this.channelRouter = channelRouter;
  }

  async send(message: AgentMessage): Promise<SendReceipt> {
    const messageId = randomUUID();
    const enqueuedAt = Date.now();

    if (message.targetAgentId) {
      // Direct delivery: dispatch to the target agent's handler.
      const handler = this.handlers.get(message.targetAgentId);
      if (handler) {
        process.nextTick(() => {
          handler(message).catch((err) => {
            console.error(`[agent-bus] handler error for ${message.targetAgentId}:`, err);
          });
        });
      }
    } else if (message.channel) {
      // Channel-based delivery: resolve subscribers and fan out.
      const subscribers = await this.channelRouter.resolve(
        message.tenantId!,
        message.channel,
        message.sourceAgentId,
      );
      for (const agentId of subscribers) {
        const handler = this.handlers.get(agentId);
        if (handler) {
          process.nextTick(() => {
            handler(message).catch((err) => {
              console.error(`[agent-bus] handler error for ${agentId}:`, err);
            });
          });
        }
      }
    } else {
      throw new Error('AgentMessage must have either targetAgentId or channel');
    }

    return { messageId, enqueuedAt };
  }

  subscribe(agentId: string, handler: AgentMessageHandler): void {
    this.handlers.set(agentId, handler);
  }

  unsubscribe(agentId: string): void {
    this.handlers.delete(agentId);
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
  }
}
```

Key characteristics of the in-memory implementation:

- `send()` dispatches asynchronously via `process.nextTick()` to avoid blocking the caller.
- No persistence (messages are lost on process exit, which is acceptable for desktop mode).
- Handler errors are logged and swallowed (never propagated to the sender).
- The `ChannelRouter` dependency is injected (see section 4.8).

### 3.4 QueueAgentBus

Production implementation backed by the queue infrastructure from the [queue spike](queue_spike.md).

```typescript
// src/bus/queueAgentBus.ts

import { randomUUID } from 'node:crypto';
import type { QueueAdapter } from '../queue/types.js';
import type { AgentBus, AgentMessage, AgentMessageHandler, SendReceipt } from './types.js';

/**
 * Production agent bus. Uses a dedicated queue topic ('agent-messages')
 * separate from the observability event topic. This prevents high-volume
 * trace events from creating backpressure on agent message delivery.
 */
class QueueAgentBus implements AgentBus {
  private adapter: QueueAdapter;
  private handlers = new Map<string, AgentMessageHandler>();
  private channelRouter: ChannelRouter;

  /** Dedicated topic name, separate from observability events. */
  private static readonly TOPIC = 'agent-messages';

  /** Dead letter topic for messages that exceed retry limits. */
  private static readonly DLQ_TOPIC = 'agent-messages-dlq';

  /** Maximum delivery attempts before moving to dead letter queue. */
  private static readonly MAX_RETRIES = 5;

  constructor(adapter: QueueAdapter, channelRouter: ChannelRouter) {
    this.adapter = adapter;
    this.channelRouter = channelRouter;
  }

  async send(message: AgentMessage): Promise<SendReceipt> {
    const messageId = randomUUID();
    const enqueuedAt = Date.now();

    const envelope = {
      ...message,
      _messageId: messageId,
      _enqueuedAt: enqueuedAt,
      _retryCount: 0,
    };

    if (!message.targetAgentId && !message.channel) {
      throw new Error('AgentMessage must have either targetAgentId or channel');
    }

    // Resolve channel subscribers at send time so the queue message
    // contains explicit target agent IDs.
    if (message.channel && !message.targetAgentId) {
      const subscribers = await this.channelRouter.resolve(
        message.tenantId!,
        message.channel,
        message.sourceAgentId,
      );
      // Enqueue one message per subscriber for independent delivery tracking.
      await Promise.all(
        subscribers.map((agentId) =>
          this.adapter.publishBatch([{ ...envelope, _resolvedTarget: agentId }])
        )
      );
    } else {
      await this.adapter.publishBatch([envelope]);
    }

    return { messageId, enqueuedAt };
  }

  /**
   * Register a handler and set up the queue consumer for this agent.
   * The queue adapter filters messages by the _resolvedTarget or
   * targetAgentId field.
   */
  subscribe(agentId: string, handler: AgentMessageHandler): void {
    this.handlers.set(agentId, handler);
    this.adapter.subscribe(`agent.message.${agentId}`, async (event) => {
      const message = event as unknown as AgentMessage;
      try {
        await handler(message);
      } catch (err) {
        console.error(`[agent-bus] handler error for ${agentId}:`, err);
        // Queue adapter handles retry/DLQ based on throw behavior.
        throw err;
      }
    });
  }

  unsubscribe(agentId: string): void {
    this.handlers.delete(agentId);
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
    await this.adapter.close();
  }
}
```

Key characteristics of the queue-backed implementation:

- **Separate topic**: agent messages go to `agent-messages`, not the observability event topic. This prevents trace event volume from starving agent message delivery.
- **At-least-once delivery**: the queue adapter acknowledges messages only after the handler completes successfully. Failed handlers trigger retry.
- **Dead letter queue**: messages that exceed `MAX_RETRIES` (5 attempts) are moved to `agent-messages-dlq` for manual inspection.
- **Channel resolution at send time**: subscriber lists are resolved before enqueuing, so each subscriber gets an independent message with independent delivery tracking.

### 3.5 Factory and Configuration

```typescript
// src/bus/index.ts

import type { AgentBus } from './types.js';
import type { QueueAdapter } from '../queue/types.js';

/**
 * Creates the appropriate AgentBus implementation based on environment config.
 *
 * AGENT_BUS_MODE values:
 * - 'memory' (default): InMemoryAgentBus, suitable for desktop mode and tests.
 * - 'queue': QueueAgentBus, requires a configured QueueAdapter.
 */
export function createAgentBus(
  adapter?: QueueAdapter,
  channelRouter?: ChannelRouter,
): AgentBus {
  const mode = process.env.AGENT_BUS_MODE ?? 'memory';

  switch (mode) {
    case 'queue': {
      if (!adapter) {
        throw new Error('QueueAgentBus requires a QueueAdapter. Set QUEUE_DRIVER.');
      }
      if (!channelRouter) {
        throw new Error('QueueAgentBus requires a ChannelRouter.');
      }
      const { QueueAgentBus } = require('./queueAgentBus.js');
      return new QueueAgentBus(adapter, channelRouter);
    }
    case 'memory':
    default: {
      const { InMemoryAgentBus } = require('./inMemoryAgentBus.js');
      return new InMemoryAgentBus(channelRouter ?? new NoOpChannelRouter());
    }
  }
}
```

| Environment Variable | Required | Default | Purpose |
|---------------------|----------|---------|---------|
| `AGENT_BUS_MODE` | No | `memory` | `memory` or `queue` |
| `QUEUE_DRIVER` | When `AGENT_BUS_MODE=queue` | - | Queue backend (reuses existing config from queue spike) |

---

## 4. Dynamic Channels

### 4.1 Channel Model

A channel is a named, tenant-scoped message topic. Agents subscribe to channels relevant to their role. Channels decouple agent communication from hardcoded agent-to-agent references, enabling flexible team topologies where agents can be added, removed, or replaced without updating every agent that communicates with them.

Channels are conceptually similar to pub/sub topics but are scoped to a single tenant and integrated with the agent deployment lifecycle.

### 4.2 Channel Entity

```typescript
// src/domain/entities/Channel.ts

class Channel {
  /** UUIDv4 primary key. */
  id: string;

  /** Owning tenant. All channel operations are tenant-scoped. */
  tenantId: string;

  /**
   * Human-readable name, unique per tenant.
   * Validated: lowercase alphanumeric + hyphens, 1-128 characters.
   * Pattern: /^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/
   */
  name: string;

  /** Agent ID that created this channel, or 'system' for auto-provisioned channels. */
  createdBy: string;

  /**
   * Delivery pattern for messages published to this channel:
   * - broadcast: all subscribers except the sender receive the message
   * - directed: sender specifies a targetAgentId, channel used for routing context
   * - fan-out: all agents matching a specific kind receive the message (resolved at delivery time)
   */
  pattern: 'broadcast' | 'directed' | 'fan-out';

  /** Extensible metadata (TTL configuration, description, tags, etc.). */
  metadata: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

// src/domain/entities/ChannelSubscription.ts

class ChannelSubscription {
  /** UUIDv4 primary key. */
  id: string;

  /** The channel being subscribed to. */
  channelId: string;

  /** The agent subscribing to the channel. */
  agentId: string;

  /** Whether this agent publishes to the channel (informational, not enforced in MVP). */
  isPublisher: boolean;

  subscribedAt: Date;
}
```

### 4.3 Entity Schemas

Following the project's EntitySchema pattern (plain TypeScript classes with schemas defined separately):

```typescript
// src/domain/schemas/ChannelSchema.ts

import { EntitySchema } from '@mikro-orm/core';
import { Channel } from '../entities/Channel.js';

export const ChannelSchema = new EntitySchema<Channel>({
  class: Channel,
  tableName: 'channels',
  properties: {
    id: { type: 'uuid', primary: true },
    tenantId: { type: 'uuid', fieldName: 'tenant_id' },
    name: { type: 'string', length: 128 },
    createdBy: { type: 'string', fieldName: 'created_by', length: 255 },
    pattern: { type: 'string', length: 16, default: 'broadcast' },
    metadata: { type: 'json', default: '{}' },
    createdAt: { type: 'datetime', fieldName: 'created_at', onCreate: () => new Date() },
    updatedAt: { type: 'datetime', fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() },
  },
  uniques: [{ properties: ['tenantId', 'name'] }],
});

// src/domain/schemas/ChannelSubscriptionSchema.ts

import { EntitySchema } from '@mikro-orm/core';
import { ChannelSubscription } from '../entities/ChannelSubscription.js';

export const ChannelSubscriptionSchema = new EntitySchema<ChannelSubscription>({
  class: ChannelSubscription,
  tableName: 'channel_subscriptions',
  properties: {
    id: { type: 'uuid', primary: true },
    channelId: { type: 'uuid', fieldName: 'channel_id' },
    agentId: { type: 'uuid', fieldName: 'agent_id' },
    isPublisher: { type: 'boolean', fieldName: 'is_publisher', default: false },
    subscribedAt: { type: 'datetime', fieldName: 'subscribed_at', onCreate: () => new Date() },
  },
  uniques: [{ properties: ['channelId', 'agentId'] }],
});
```

### 4.4 Delivery Patterns

| Pattern | Behavior | Use Case |
|---------|----------|----------|
| **broadcast** | Message goes to all subscribers except the sender. | Status updates, event notifications (e.g., "new ticket classified"). |
| **directed** | Message goes to a specific agent via `targetAgentId`. The channel provides routing context and audit trail. | Request/response workflows between known agents. |
| **fan-out** | Message goes to all agents of a specific kind, resolved at delivery time by querying the agent registry. | Load distribution (e.g., "any available support agent"). |

Resolution rules for each pattern:

1. **broadcast**: `SELECT agent_id FROM channel_subscriptions WHERE channel_id = $1 AND agent_id != $2` (exclude sender).
2. **directed**: Validate that `targetAgentId` is subscribed to the channel, then deliver directly.
3. **fan-out**: `SELECT agent_id FROM channel_subscriptions cs JOIN agents a ON cs.agent_id = a.id WHERE cs.channel_id = $1 AND a.kind = $2` (resolved from message metadata).

### 4.5 Agent Spec Integration

Channels are declared in agent YAML specs under the `channels` key. This makes channel wiring part of the agent's declarative specification, versioned and deployed alongside the agent's other configuration.

```yaml
# Example: ticket-classifier agent spec
kind: Agent
metadata:
  name: ticket-classifier
  version: 1.2.0
spec:
  model: gpt-4o
  system_prompt: "You classify incoming support tickets..."
  channels:
    subscribe:
      - customer-intake         # receives raw tickets
      - escalation-requests     # receives escalation notifications
    publish:
      - classified-tickets      # emits classified ticket events
```

```yaml
# Example: billing-handler agent spec
kind: Agent
metadata:
  name: billing-handler
  version: 1.0.0
spec:
  model: gpt-4o
  system_prompt: "You handle billing-related support tickets..."
  channels:
    subscribe:
      - classified-tickets      # receives tickets classified as billing
    publish:
      - resolved-tickets        # emits resolution events
```

Validation rules for channel declarations:

- Channel names must match `/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/`.
- An agent can both subscribe to and publish to the same channel.
- The `subscribe` and `publish` lists are optional (an agent may only subscribe or only publish).

### 4.6 Runtime Channel API

REST endpoints for managing channels. All endpoints require a valid tenant context (API key or portal JWT).

```
POST   /v1/channels              # Create a channel
GET    /v1/channels              # List channels for the current tenant
GET    /v1/channels/:name        # Get channel details (including subscriber list)
DELETE /v1/channels/:name        # Delete a channel and all its subscriptions
POST   /v1/channels/:name/subscribe    # Subscribe an agent to a channel
DELETE /v1/channels/:name/subscribe/:agentId  # Unsubscribe an agent
```

**Create channel request:**

```json
POST /v1/channels
{
  "name": "customer-intake",
  "pattern": "broadcast",
  "metadata": {
    "description": "Raw customer support tickets",
    "ttlSeconds": 86400
  }
}
```

**Create channel response:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "tenantId": "...",
  "name": "customer-intake",
  "pattern": "broadcast",
  "metadata": { "description": "Raw customer support tickets", "ttlSeconds": 86400 },
  "createdBy": "system",
  "createdAt": "2026-03-21T12:00:00.000Z"
}
```

**List channels response:**

```json
{
  "channels": [
    {
      "name": "customer-intake",
      "pattern": "broadcast",
      "subscriberCount": 3,
      "createdAt": "2026-03-21T12:00:00.000Z"
    }
  ]
}
```

### 4.7 Deploy-Time Provisioning

When an agent or AgentTeam spec containing a `channels` block is deployed (via `arachne deploy`), the deployment pipeline automatically provisions channels and subscriptions:

1. **Parse** the `channels` block from the deployed spec.
2. **Upsert channels**: for each channel name in `subscribe` or `publish`, create the channel if it does not already exist. Use `broadcast` as the default pattern for auto-created channels.
3. **Register subscriptions**: create `ChannelSubscription` rows linking the deployed agent to each channel in its `subscribe` list. Mark entries from the `publish` list with `isPublisher = true`.
4. **Idempotency**: repeated deployments of the same spec produce the same result. Existing subscriptions are preserved (not duplicated).
5. **Cleanup on undeploy**: when a deployment is torn down, remove the agent's subscriptions. Channels themselves are not deleted (other agents may still use them).

```typescript
// Pseudocode for deploy-time channel provisioning
async function provisionChannels(
  tenantId: string,
  agentId: string,
  channelSpec: { subscribe?: string[]; publish?: string[] },
  em: EntityManager,
): Promise<void> {
  const allChannelNames = [
    ...(channelSpec.subscribe ?? []),
    ...(channelSpec.publish ?? []),
  ];
  const uniqueNames = [...new Set(allChannelNames)];

  for (const name of uniqueNames) {
    // Upsert: create if not exists
    let channel = await em.findOne(Channel, { tenantId, name });
    if (!channel) {
      channel = new Channel();
      channel.id = randomUUID();
      channel.tenantId = tenantId;
      channel.name = name;
      channel.createdBy = agentId;
      channel.pattern = 'broadcast';
      channel.metadata = {};
      em.persist(channel);
    }

    // Register subscription if agent subscribes or publishes
    const isSubscriber = channelSpec.subscribe?.includes(name) ?? false;
    const isPublisher = channelSpec.publish?.includes(name) ?? false;

    if (isSubscriber || isPublisher) {
      const existing = await em.findOne(ChannelSubscription, {
        channelId: channel.id,
        agentId,
      });
      if (!existing) {
        const sub = new ChannelSubscription();
        sub.id = randomUUID();
        sub.channelId = channel.id;
        sub.agentId = agentId;
        sub.isPublisher = isPublisher;
        em.persist(sub);
      }
    }
  }

  await em.flush();
}
```

### 4.8 Channel Lifecycle

Channels follow these lifecycle rules:

- **Creation**: channels are created either via the REST API or auto-provisioned at deploy time.
- **Persistence**: channels persist until explicitly deleted via `DELETE /v1/channels/:name` or until they expire (if TTL is set).
- **TTL (optional)**: channels with `metadata.ttlSeconds` set are eligible for expiration. A background sweep runs periodically to clean up expired channels.
- **Deletion cascade**: deleting a channel removes all associated `ChannelSubscription` rows.
- **Orphan protection**: channels are not auto-deleted when their creating agent is undeployed. Other agents may still reference the channel.

**Background TTL sweep:**

```typescript
// Runs every 60 seconds (configurable via CHANNEL_SWEEP_INTERVAL_MS)
async function sweepExpiredChannels(em: EntityManager): Promise<number> {
  const now = Date.now();
  const expired = await em.getConnection().execute(`
    DELETE FROM channels
    WHERE metadata->>'ttlSeconds' IS NOT NULL
      AND created_at + (metadata->>'ttlSeconds')::int * interval '1 second' < NOW()
    RETURNING id
  `);
  return expired.length;
}
```

### 4.9 ChannelRouter

The `ChannelRouter` resolves a channel name to a list of subscriber agent IDs. It is the core routing component used by both `InMemoryAgentBus` and `QueueAgentBus`.

```typescript
// src/bus/channels.ts

import { LRUCache } from 'lru-cache';

interface ChannelRouter {
  /**
   * Resolve a channel name to the list of agent IDs that should
   * receive a message, excluding the sender.
   */
  resolve(tenantId: string, channelName: string, senderAgentId: string): Promise<string[]>;

  /** Invalidate the cache for a specific channel (after subscription changes). */
  invalidate(tenantId: string, channelName: string): void;
}

class DefaultChannelRouter implements ChannelRouter {
  /**
   * LRU cache keyed by "tenantId:channelName".
   * Stores the full subscriber list; sender exclusion is applied at read time.
   * TTL: 30 seconds. Max entries: 1,000.
   */
  private cache = new LRUCache<string, string[]>({
    max: 1_000,
    ttl: 30_000,
  });

  private em: EntityManager;

  constructor(em: EntityManager) {
    this.em = em;
  }

  async resolve(
    tenantId: string,
    channelName: string,
    senderAgentId: string,
  ): Promise<string[]> {
    const cacheKey = `${tenantId}:${channelName}`;

    let subscribers = this.cache.get(cacheKey);
    if (!subscribers) {
      const rows = await this.em.getConnection().execute(`
        SELECT cs.agent_id
        FROM channel_subscriptions cs
        JOIN channels c ON cs.channel_id = c.id
        WHERE c.tenant_id = $1 AND c.name = $2
      `, [tenantId, channelName]);

      subscribers = rows.map((r: { agent_id: string }) => r.agent_id);
      this.cache.set(cacheKey, subscribers);
    }

    // Exclude the sender from broadcast delivery.
    return subscribers.filter((id) => id !== senderAgentId);
  }

  invalidate(tenantId: string, channelName: string): void {
    this.cache.delete(`${tenantId}:${channelName}`);
  }
}

/**
 * No-op router used when channels are not configured.
 * Always returns an empty subscriber list.
 */
class NoOpChannelRouter implements ChannelRouter {
  async resolve(): Promise<string[]> {
    return [];
  }
  invalidate(): void {}
}
```

Tenant isolation is enforced at the query level: the `resolve()` method always filters by `tenantId`. There is no code path that can return subscribers from a different tenant.

---

## 5. Integration Points

### 5.1 Observability Architecture (observability_architecture.md)

- The `AgentBus` extends the infrastructure introduced in section 5.1 (EventBus interface) and section 5.3 (QueueAdapter contract) of the observability spec.
- The `QueueAgentBus` reuses the same `QueueAdapter` implementations (BullMQ, RabbitMQ, etc.) but publishes to a separate topic (`agent-messages` instead of the observability event topic).
- Both bus instances (`EventBus` and `AgentBus`) are created at server startup and share the same queue connection pool where possible.

### 5.2 Queue Spike (queue_spike.md)

- The `QUEUE_DRIVER` environment variable (from the queue spike) determines the queue backend for both observability events and agent messages.
- The `QueueAdapter` interface is shared. No changes to the adapter contract are required.

### 5.3 Observability Events

The messaging system emits the following events via the existing `EventBus`:

| Event | Visibility | Fires When | Key Fields |
|-------|-----------|------------|------------|
| `agent.message_sent` | Both | `AgentBus.send()` completes | `sourceAgentId`, `targetAgentId`, `channel`, `correlationId`, `durable` |
| `agent.message_received` | Both | Agent handler invoked | `targetAgentId`, `sourceAgentId`, `channel`, `correlationId`, `handlerMs` |
| `agent.message_failed` | Both | Message moved to DLQ | `targetAgentId`, `channel`, `correlationId`, `retryCount`, `error` |
| `channel.created` | Internal | New channel provisioned | `channelName`, `pattern`, `createdBy` |
| `channel.deleted` | Internal | Channel removed | `channelName`, `subscriberCount` |
| `channel.subscription_added` | Internal | Agent subscribed to channel | `channelName`, `agentId` |
| `channel.subscription_removed` | Internal | Agent unsubscribed from channel | `channelName`, `agentId` |

### 5.4 Agent Teams

AgentTeam specs (multi-agent coordination) reference channels for intra-team communication. When a team is deployed, the team's coordinator agent and member agents are wired together via channels declared in the team spec:

```yaml
kind: AgentTeam
metadata:
  name: support-team
spec:
  coordinator: ticket-router
  members:
    - billing-handler
    - technical-support
    - escalation-manager
  channels:
    - name: team-internal
      pattern: broadcast
    - name: escalation
      pattern: directed
```

---

## 6. Security Considerations

### 6.1 Tenant Isolation

- All channel operations (create, list, delete, subscribe) require a valid tenant context resolved from the API key or portal JWT.
- The `Channel.tenantId` field is set at creation time and cannot be changed.
- The `ChannelRouter.resolve()` method always filters by `tenantId`. Cross-tenant message delivery is not possible in the current architecture.
- Channel names are unique per tenant (not globally). Two tenants can have channels with the same name without conflict.

### 6.2 Message Payload Encryption

- Message payloads are encrypted at rest using the same per-tenant AES-256-GCM encryption used for traces and conversation messages.
- Key derivation follows the existing pattern: `HMAC-SHA256(ENCRYPTION_MASTER_KEY, tenantId)` produces the per-tenant data encryption key (DEK).
- In the queue-backed implementation, messages are encrypted before being published to the queue and decrypted by the consumer handler.
- In the in-memory implementation, no encryption is applied (messages never leave the process).

### 6.3 Channel Name Validation

- Channel names are validated against the pattern `/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/`.
- Maximum length: 128 characters.
- Names must start and end with an alphanumeric character.
- Only lowercase letters, digits, and hyphens are permitted.
- Names are case-insensitive (stored lowercase).

### 6.4 Authorization

- In the MVP, any agent within a tenant can subscribe to or publish on any channel within that tenant.
- Channel-level access control (restricting which agents can subscribe or publish) is deferred to a future iteration (see section 8).
- The `isPublisher` flag on `ChannelSubscription` is informational in the MVP and not enforced.

---

## 7. Database Schema

### 7.1 Migration: Create channels table

```sql
-- Migration: create_channels_table

CREATE TABLE channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(128) NOT NULL,
  created_by  VARCHAR(255) NOT NULL,
  pattern     VARCHAR(16) NOT NULL DEFAULT 'broadcast'
              CHECK (pattern IN ('broadcast', 'directed', 'fan-out')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_channels_tenant_id ON channels (tenant_id);
CREATE INDEX idx_channels_tenant_name ON channels (tenant_id, name);
```

### 7.2 Migration: Create channel_subscriptions table

```sql
-- Migration: create_channel_subscriptions_table

CREATE TABLE channel_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  is_publisher  BOOLEAN NOT NULL DEFAULT FALSE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (channel_id, agent_id)
);

CREATE INDEX idx_channel_subs_channel_id ON channel_subscriptions (channel_id);
CREATE INDEX idx_channel_subs_agent_id ON channel_subscriptions (agent_id);
```

### 7.3 Rollback

```sql
-- Down migration

DROP TABLE IF EXISTS channel_subscriptions;
DROP TABLE IF EXISTS channels;
```

---

## 8. Future Extensions

The following capabilities are explicitly out of scope for the MVP but are anticipated for future iterations:

1. **Cross-tenant channels**: for marketplace scenarios where agents from different tenants need to communicate (e.g., a shared "marketplace-orders" channel). Requires a trust model and cross-tenant encryption key negotiation.

2. **Message persistence and replay**: durable storage of all messages passing through a channel, enabling audit trails and replay for debugging or recovery. Would require a `channel_messages` table with retention policies.

3. **Channel access control**: fine-grained permissions beyond tenant scope. Restrict which agents can subscribe to or publish on specific channels. Enforce the `isPublisher` flag.

4. **Distributed channels across Arachne instances**: for multi-region or federated deployments where channel subscribers span multiple Arachne instances. Requires a distributed membership protocol.

5. **Message schemas and contracts**: typed message payloads with JSON Schema validation per channel. Reject messages that don't conform to the channel's declared schema.

6. **Rate limiting per channel**: prevent a single agent from flooding a channel. Configurable via `metadata.maxMessagesPerMinute`.

7. **Channel metrics in tenant dashboards**: message throughput, delivery latency, and error rates per channel exposed in Recharts dashboards.

8. **Priority queues**: support message priority levels so urgent messages (e.g., escalation) are delivered before routine messages.
