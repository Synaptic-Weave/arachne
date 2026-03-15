---
title: API Reference
description: Complete Arachne gateway and portal API reference
order: 1
---


Arachne exposes three API surfaces: the **Gateway** for LLM inference, the **Portal API** for tenant self-service, and the **Admin API** for system-wide operations.

## Gateway API

The gateway is OpenAI-compatible. Any client that works with the OpenAI API works with Arachne.

### POST /v1/chat/completions

Send a chat completion request through the gateway. The agent, model, and provider are resolved from the API key.

**Authentication:** Bearer token or `x-api-key` header with your Arachne API key.

**Request Body:**

```json
{
  "messages": [
    { "role": "user", "content": "What is Arachne?" }
  ],
  "stream": true,
  "conversation_id": "conv_abc123",
  "partition_id": "user_42"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | `array` | Yes | Array of chat messages (`role` + `content`) |
| `stream` | `boolean` | No | Enable server-sent event streaming (default: `false`) |
| `conversation_id` | `string` | No | Conversation thread ID for memory continuity |
| `partition_id` | `string` | No | Partition key for data isolation within a tenant |
| `temperature` | `number` | No | Sampling temperature (passed through to provider) |
| `max_tokens` | `number` | No | Maximum tokens in the response |
| `tools` | `array` | No | Tool/function definitions for function calling |
| `tool_choice` | `string \| object` | No | Tool selection strategy |

**Response (non-streaming):**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Arachne is an AI runtime..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 89,
    "total_tokens": 113
  },
  "rag_sources": [
    {
      "chunk_id": "chunk_001",
      "content": "Arachne is a multi-tenant AI gateway...",
      "similarity": 0.92,
      "knowledge_base": "product-docs"
    }
  ]
}
```

**RAG Sources:** When the agent has an attached knowledge base, the response includes a `rag_sources` array with the retrieved chunks, their similarity scores, and the source knowledge base. This enables citation and transparency in RAG-powered responses.

**Streaming Response:** When `stream: true`, the response is delivered as server-sent events in OpenAI-compatible format:

```
data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"Arachne"},"index":0}]}

data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":" is"},"index":0}]}

data: [DONE]
```

---

## Portal API

The portal API powers the self-service UI. All endpoints require a Portal JWT token obtained via login.

**Base path:** `/v1/portal`

**Authentication:** `Authorization: Bearer <portal_jwt>`

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/signup` | Create a new account and tenant |
| POST | `/auth/login` | Authenticate and receive a JWT |
| POST | `/auth/switch-tenant` | Switch active tenant context |

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents` | List all agents in the current tenant |
| POST | `/agents` | Create a new agent |
| GET | `/agents/:id` | Get agent details |
| PUT | `/agents/:id` | Update an agent |
| DELETE | `/agents/:id` | Delete an agent |

### Knowledge Bases

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge-bases` | List knowledge bases |
| POST | `/knowledge-bases` | Create a knowledge base with file upload |
| GET | `/knowledge-bases/:id` | Get knowledge base details and chunks |
| DELETE | `/knowledge-bases/:id` | Delete a knowledge base |

### API Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api-keys` | List API keys (masked) |
| POST | `/api-keys` | Generate a new API key |
| DELETE | `/api-keys/:id` | Revoke an API key |

### Members

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/members` | List tenant members |
| POST | `/invites` | Send an invite |
| DELETE | `/members/:id` | Remove a member |

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings` | Get tenant settings |
| PUT | `/settings` | Update tenant settings |
| GET | `/settings/providers` | Get provider configurations |
| PUT | `/settings/providers` | Update provider configurations |

---

## Admin API

The admin API is for system operators managing the Arachne instance. All endpoints require an Admin JWT.

![Admin dashboard](/screenshots/admin-traces.png)

**Base path:** `/v1/admin`

**Authentication:** `Authorization: Bearer <admin_jwt>`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tenants` | List all tenants |
| POST | `/tenants` | Create a tenant |
| GET | `/tenants/:id` | Get tenant details |
| PUT | `/tenants/:id` | Update tenant settings |
| GET | `/providers` | List global provider configurations |
| POST | `/providers` | Create a provider configuration |
| PUT | `/providers/:id` | Update a provider configuration |
| DELETE | `/providers/:id` | Delete a provider configuration |
| GET | `/analytics/summary` | System-wide analytics summary |
| GET | `/analytics/timeseries` | System-wide request timeseries |

---

## Error Responses

All APIs return errors in a consistent format:

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "The provided API key is invalid or has been revoked."
  }
}
```

Common HTTP status codes:

| Status | Meaning |
|--------|---------|
| 400 | Bad request — invalid parameters |
| 401 | Unauthorized — missing or invalid credentials |
| 403 | Forbidden — insufficient permissions |
| 404 | Not found |
| 429 | Rate limited |
| 502 | Upstream provider error |
