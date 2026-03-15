---
title: Getting Started
description: Set up Arachne and create your first AI agent
order: 1
---

Get Arachne running and make your first AI-powered API call in under five minutes.

## 1. Sign Up

Create an account on the Arachne portal:

```
https://app.arachne-ai.com/signup
```

After signing up, you'll land in the portal dashboard where you can manage agents, knowledge bases, and API keys.

![Portal after login](/screenshots/portal-login-success.png)

## 2. Configure a Provider

Arachne acts as a gateway to any LLM provider. Before creating an agent, your administrator needs to configure at least one gateway provider in the dashboard. As a tenant user, you can also configure your own provider under **Settings**.

![Provider settings](/screenshots/portal-settings.png)

### OpenAI

1. Enter your OpenAI API key.
2. Select available models (e.g., `gpt-4o`, `gpt-4o-mini`).
3. Save.

### Azure OpenAI

1. Enter your Azure endpoint URL, API key, and deployment name.
2. Select the API version (e.g., `2024-12-01-preview`).
3. Save.

### Ollama

1. Enter the Ollama base URL (e.g., `http://localhost:11434`).
2. No API key is required for local instances.
3. Save.

Arachne encrypts all provider credentials at rest using AES-256-GCM with per-tenant key derivation.

## 3. Create Your First Agent

Navigate to **Agents** and click **+ New Agent**.

![Agent editor](/screenshots/portal-agent-editor.png)

| Field | Example | Description |
|-------|---------|-------------|
| Name | `support-bot` | A human-readable identifier |
| Provider | *Tenant Default* or a gateway provider | Which provider to route requests through |
| System Prompt | `You are a helpful support assistant.` | Instructions that shape agent behavior |

You can also enable **conversation memory** to let the agent retain context across requests, and attach a **knowledge base** for RAG-powered responses.

## 4. Test in the Sandbox

Every agent comes with a built-in sandbox. Click **Test** on your agent to open an interactive chat session. The sandbox routes through the full gateway pipeline — RAG retrieval, conversation memory, and merge policies all work exactly as they would in production.

![Sandbox](/screenshots/portal-sandbox.png)

## 5. Create an API Key

Go to **API Keys** and click **Generate Key**. Each key is bound to a specific agent and tenant. Copy the key immediately — it won't be shown again.

![API keys](/screenshots/portal-api-keys.png)

> Store your API key securely. Arachne stores only a SHA-256 hash of each key in the database.

## 6. Make Your First API Call

Arachne exposes an OpenAI-compatible endpoint, so any existing OpenAI SDK or HTTP client works out of the box.

### Using curl

```bash
curl -X POST https://api.arachne-ai.com/v1/chat/completions \
  -H "Authorization: Bearer loom_sk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Hello, what can you help me with?" }
    ]
  }'
```

### Using the OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "loom_sk_your_api_key",
  baseURL: "https://api.arachne-ai.com/v1",
});

const response = await client.chat.completions.create({
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

The model, system prompt, and provider are resolved automatically from the agent bound to your API key. No need to specify them in the request.

## Next Steps

- [Portal Guide](/docs/portal-guide) — Explore the full self-service portal.
- [CLI Quickstart](/docs/cli-quickstart) — Define agents as code with the Arachne CLI.
- [API Reference](/developers/api-reference) — Full endpoint documentation.
- [RAG Inference](/developers/rag-inference) — Add knowledge bases to your agents.
