# Arachne

Arachne is an **AI runtime**, **developer toolchain**, and **open spec** for defining portable agents and knowledge bases that run anywhere.

- **Runtime** — A multi-tenant AI gateway that proxies requests to any LLM provider (OpenAI, Azure, Ollama, and more) with built-in observability, conversation memory, and RAG inference
- **Developer tools** — A CLI (`arachne`) for defining Agent and KnowledgeBase artifacts as YAML specs, weaving them into signed bundles, pushing to a registry, and deploying to any tenant
- **Portable spec** — Agents and knowledge bases are defined as versioned, content-addressed artifacts with a stable schema — write once, deploy anywhere

## What You Can Build

- **AI-powered products** with multi-tenant isolation, per-tenant agent configuration, and encrypted trace storage
- **Portable agents** defined as YAML specs with system prompts, tools, and RAG knowledge — versioned and deployable via the registry
- **Knowledge pipelines** that chunk documents, generate embeddings, and serve vector search through a consistent RAG inference interface

## Core Capabilities

| Capability | What it does |
|---|---|
| LLM Gateway | OpenAI-compatible proxy routing to OpenAI, Azure OpenAI, or Ollama |
| Agent Registry | Push/pull versioned agent and knowledge base artifacts |
| RAG Inference | Automatic embedding, retrieval, and citation injection |
| Conversation Memory | Persistent multi-turn context with automatic summarization |
| Observability | Encrypted trace recording, token analytics, latency metrics (p95/p99) |
| Multi-tenancy | Strict data isolation, subtenant hierarchy, per-tenant provider config |
| Portal | Tenant-facing web UI for managing agents, keys, and analytics |

## Getting Started

See [Running Locally](RUNNING_LOCALLY.md) — Docker Compose (recommended) or Node.js dev mode.

## CLI

The `arachne` CLI lets you define and deploy agent artifacts from your terminal:

```bash
arachne weave agent.yaml          # bundle an agent spec
arachne push myorg/my-agent:1.0   # push to registry
arachne deploy myorg/my-agent:1.0 # deploy to a tenant
```

→ [CLI Reference](docs/cli.md) · [How the artifact model works](docs/cli-overview.md)

## Documentation

| Doc | What's in it |
|---|---|
| [Running Locally](RUNNING_LOCALLY.md) | Setup with Docker Compose or Node.js |
| [CLI Reference](docs/cli.md) | All `arachne` commands with examples |
| [CLI Overview](docs/cli-overview.md) | Artifact model, weave pipeline, registry, deployment |
| [RAG Inference](docs/rag-inference.md) | How retrieval and embedding work |
| [Registry API](docs/registry-api.md) | HTTP API for the artifact registry |
| [Portal Guide](docs/portal-guide.md) | Using the tenant web portal |
| [System Embedder](docs/system-embedder.md) | Configuring a default embedding provider |
| [Architecture](docs/architecture.md) | Component design, data flows, encryption |
| [Developer Guide](docs/developer-guide.md) | Source layout, database schema, API extensions |
