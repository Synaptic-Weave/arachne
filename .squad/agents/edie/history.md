# Edie — History

## Project Context

**Project:** Arachne (formerly Loom) — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript, React (portal), Fastify, MikroORM, PostgreSQL + pgvector  
**Description:** Provider-agnostic OpenAI-compatible proxy with multi-tenant support, observability dashboard, agent management, and RAG/knowledge base system.

**Key docs locations:**
- `docs/` — architecture docs, CLI reference, feature guides
- `README.md` — project overview, quickstart
- `RUNNING_LOCALLY.md` — local dev setup
- `docs/cli.md` — CLI command reference
- `docs/cli-overview.md` — CLI architecture + design decisions

## What shipped in P0 (context on day 1)

The P0 sprint shipped the Arachne CLI + RAG Knowledge Base system. Key new features:
- `arachne` CLI with `login`, `weave`, `push`, `deploy` commands
- Registry + artifact pipeline (WeaveService, RegistryService, ProvisionService)
- RAG inference retrieval (pgvector semantic search injected at call time)
- Tenant org slug configuration
- System embedder via `SYSTEM_EMBEDDER_*` env vars
- Portal UI: KnowledgeBasesPage, DeploymentsPage, AgentEditor KB selector

**Current doc state:** `docs/cli-overview.md` and `docs/cli.md` were updated during P0. README and RUNNING_LOCALLY were rebranded to Arachne. Coverage gaps exist — new portal pages, registry API, and RAG inference have no user-facing docs yet.

## Team

- Keaton — Lead (architecture, decisions)
- Fenster — Backend Dev
- McManus — Frontend Dev
- Hockney — Tester
- Redfoot — Data Engineer
- Verbal — Domain Model Expert
- Kobayashi — AI Expert
- Edie — Technical Writer (me)
- Scribe — Session Logger

## Definition of Done (team-wide, from Michael)

Stories are not done until:
1. Code coverage for new features is ≥80%
2. Internal and public user docs are written/updated for what changed or was added

## Learnings
