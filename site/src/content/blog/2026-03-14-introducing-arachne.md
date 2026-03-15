---
title: "Introducing Arachne: Docker for AI Agents"
date: 2026-03-14
author: Michael Brown
description: "An open AI runtime that makes agents portable, observable, and deployable — like containers did for services."
tags:
  - launch
  - open-source
  - agents
---


AI agents are having their "pre-Docker" moment. Every team builds them differently. They're tangled into application code, locked to a single provider, and impossible to move between environments. There's no standard way to define, version, or deploy an agent.

We built Arachne to fix that.

## Why Arachne

Containers gave us a portable unit of deployment for services. Arachne does the same for AI agents. An agent — its model, system prompt, skills, knowledge base, and behavior settings — becomes a versioned artifact that can be pushed to a registry and deployed to any Arachne-compatible runtime.

The result: agents that are portable across providers, observable by default, and deployable with the same confidence as a container image.

## What Arachne Does

### A Portable Agent Spec

Define your agent in a declarative YAML file:

```yaml
kind: Agent
name: support-bot
version: 2.1.0

model: gpt-4o
provider: openai

system_prompt: |
  You are a support assistant for Acme Corp.
  Answer questions using the provided knowledge base.

conversations:
  enabled: true
  token_limit: 8000

knowledge_base:
  ref: support-docs
  top_k: 5
```

This spec is the single source of truth. Weave it into an artifact, push it to a registry, deploy it anywhere. No code changes, no environment-specific configuration.

### Multi-Provider Gateway

Arachne sits between your application and any LLM provider. It exposes an OpenAI-compatible API, so existing SDKs and tools work without modification. Under the hood, provider adapters handle the differences between OpenAI, Azure OpenAI, and Ollama.

Switch providers by changing a configuration value. No code changes, no redeployment of your application.

### RAG Bundles

Knowledge bases are first-class citizens. Upload documents, and Arachne chunks them, generates embeddings, and stores the vectors in PostgreSQL with pgvector. At query time, the gateway automatically retrieves relevant context and injects it into the prompt.

RAG metadata — similarity scores, chunk sources, and retrieval latency — is returned in every response, giving you full visibility into what influenced each answer.

### Conversation Memory

Enable conversation memory on any agent to maintain context across requests. Arachne stores messages, manages token budgets, and automatically summarizes history when it exceeds the configured limit. No external memory store, no custom middleware.

### Built-In Observability

Every request is traced automatically. Token usage, latency, model, provider, and full request/response bodies are recorded — encrypted at rest with per-tenant keys. The operator dashboard surfaces analytics in real time: request volume, model breakdown, latency percentiles, and cost tracking.

## Getting Started

Arachne is open source and self-hostable. Get running in minutes:

```bash
# Clone and install
git clone https://github.com/arachne-ai/arachne.git
cd arachne && npm install

# Start PostgreSQL
docker compose up -d postgres

# Configure and migrate
cp .env.example .env
npm run migrate:up

# Start the runtime
npm run dev
```

Or use the CLI to define and deploy agents from your terminal:

```bash
npm install -g @arachne/cli
arachne login --instance https://api.arachne-ai.com
arachne weave agent.yaml --push --deploy
```

Read the full [Getting Started](/docs/getting-started) guide for a detailed walkthrough.

## What's Next

This is the beginning. Here is what we're working on:

- **More providers** — Anthropic, Google Gemini, AWS Bedrock, and Groq adapters are in development.
- **Agent composition** — Chain multiple agents together with typed inputs and outputs.
- **Managed hosting** — A hosted version of Arachne for teams that don't want to run infrastructure.
- **MCP ecosystem** — Deeper integration with the Model Context Protocol for tool use and external data sources.
- **Community registry** — A public registry for sharing agent specs and knowledge base templates.

We believe the future of AI development looks a lot like the container ecosystem: portable specs, versioned artifacts, and runtime environments that handle the hard parts. Arachne is our contribution to making that future real.

Star us on [GitHub](https://github.com/arachne-ai/arachne), join the [community](https://discord.gg/arachne), or [get started](/docs/getting-started) today.
