# Arachne Product Roadmap

> **Version:** 1.0 | **Last updated:** March 15, 2026 | **Author:** Michael Brown
> **Status:** Active — Phase 1 in progress

---

## Executive Summary

Arachne is an open-source AI runtime, developer toolchain, and open spec for defining portable agents and knowledge bases. Today, the platform runs as a single-process Fastify server that proxies requests to OpenAI, Azure OpenAI, and Ollama with multi-tenant isolation, encrypted trace recording, conversation memory, RAG inference, and three web frontends (Portal, Dashboard, Admin).

**Where we are.** Arachne is in private beta with a functional gateway, tenant self-service portal, operator dashboard, artifact registry, and CLI. The core proxy path handles streaming and non-streaming completions with MCP tool-call round-trips. Conversation memory, RAG retrieval, and per-tenant encryption are operational. The platform supports three LLM providers.

**Where we are going.** Over the next twelve months we will harden the beta into a production-grade runtime, expand provider coverage to seven providers, introduce agent evaluation frameworks, and build an ecosystem layer with a marketplace, plugin system, and SSO. The open spec for agent and knowledge-base definitions will move toward community governance.

**Why it matters.** Organizations adopting LLMs face a fragmented landscape: every provider has its own API surface, auth model, and billing. Arachne gives teams a single control plane with encryption at rest, audit-grade observability, and the freedom to swap providers without rewriting application code. Unlike closed platforms (OpenAI Assistants, AWS Bedrock Agents), Arachne is open-source, self-hostable, and designed for multi-tenant SaaS deployment from day one.

---

## Phase 1: Beta Hardening

**Timeline:** Now through mid-April 2026
**Theme:** Make the existing system reliable, testable, and safe for early production workloads.

Phase 1 is about closing the gaps that separate a working prototype from software that operators can trust with real traffic. Every item in this phase targets either reliability (test coverage, EM lifecycle), security (API key expiry, encryption hygiene), or operational breadth (more providers, bridge adapter).

### 1.1 EntityManager Forking (#109)

**What it is.** Refactor all request-scoped database operations to use a forked `EntityManager` per request rather than sharing a single instance across concurrent requests.

**Why it matters.** MikroORM's identity map tracks loaded entities. Without request-scoped forking, concurrent requests can read stale state or corrupt each other's unit-of-work. This is a correctness issue that becomes a data-integrity issue under load.

**Dependencies.** None — this is foundational and should land first.

**Key architectural decisions.**
- Use Fastify's `onRequest` hook to call `em.fork()` and attach the forked EM to the request context.
- All services that currently inject the root `EntityManager` must be updated to accept a request-scoped fork.
- The forked EM is discarded after the response completes, ensuring clean identity maps per request.

---

### 1.2 Multi-Provider Expansion: 3 to 7 Providers (#110)

**What it is.** Add provider adapters for Anthropic (Claude), Google (Gemini), AWS Bedrock, and Mistral, bringing the total from three (OpenAI, Azure OpenAI, Ollama) to seven.

**Why it matters.** Provider lock-in is the primary concern for teams evaluating AI runtimes. Supporting seven providers at launch makes Arachne the broadest open-source gateway available. Early adopters have specifically requested Anthropic and Google support.

**Dependencies.** None — each adapter is independent, though they all extend `BaseProvider`.

**Key architectural decisions.**
- Each adapter lives in `src/providers/` and implements the `BaseProvider` abstract class.
- Anthropic and Google use different message formats; adapters must translate to/from the OpenAI-compatible schema that Arachne uses internally.
- AWS Bedrock requires IAM credential handling (access key + secret or assumed role); this introduces a new credential type beyond simple API keys.
- Mistral's API is OpenAI-compatible, so the adapter is lightweight — primarily URL and auth header mapping.
- All new providers must support both streaming and non-streaming modes.

---

### 1.3 API Key Expiry and Rotation (#111)

**What it is.** Add `expires_at` and `last_rotated_at` columns to the `api_keys` table, enforce expiry at the auth middleware layer, and provide Portal UI for key rotation.

**Why it matters.** Production deployments require key lifecycle management. Without expiry, compromised keys remain valid indefinitely. Without rotation, teams cannot adopt key-hygiene policies required by SOC 2 and similar frameworks.

**Dependencies.** None.

**Key architectural decisions.**
- Expiry check happens in the LRU-cached auth path (`src/auth.ts`). Expired keys must be evicted from cache and rejected.
- Rotation creates a new key and invalidates the old one atomically. A grace period (configurable, default 24 hours) allows both keys to work during transition.
- The Portal UI exposes rotation controls and shows expiry status on the API Keys page.

---

### 1.4 Provider Bridge Adapter (#112)

**What it is.** A generic bridge adapter that allows tenants to proxy requests to any OpenAI-compatible endpoint by configuring a base URL, auth header, and optional request/response transforms.

**Why it matters.** The LLM ecosystem moves faster than any team can ship dedicated adapters. The bridge lets operators connect to new providers, internal model servers, or custom endpoints without waiting for a first-party adapter.

**Dependencies.** Depends on the `BaseProvider` interface being stable (which it already is).

**Key architectural decisions.**
- Configuration stored per-tenant in `provider_configs` with `type: 'bridge'`.
- Supports optional Jsonata or JavaScript transforms for request/response mapping.
- The bridge does not attempt to normalize token usage or cost metrics — those are best-effort based on the upstream response format.

---

### 1.5 Comprehensive Test Suite (#113)

**What it is.** Achieve 80%+ line coverage across core modules (`src/auth.ts`, `src/agent.ts`, `src/streaming.ts`, `src/tracing.ts`, all services) with unit, integration, and smoke tests.

**Why it matters.** The current test suite covers happy paths but leaves edge cases (malformed requests, provider timeouts, concurrent EM access, encryption key rotation) untested. Before inviting production traffic, we need confidence that the gateway handles failure gracefully.

**Dependencies.** EntityManager forking (#109) should land first so tests can validate the correct forking behavior.

**Key architectural decisions.**
- Unit tests mock `EntityManager` and external HTTP calls (undici).
- Integration tests use `DB_DRIVER=sqlite` for real ORM operations without PostgreSQL.
- Smoke tests use Playwright against a running server with Docker Compose.
- Coverage gates enforced in CI — PRs that reduce coverage below 80% are blocked.

---

### 1.6 Streaming Robustness (#114)

**What it is.** Harden the SSE transform stream (`src/streaming.ts`) to handle backpressure, upstream disconnects, malformed chunks, and client abort scenarios without leaking resources.

**Why it matters.** Streaming is the primary mode for chat applications. Resource leaks or hung connections under edge conditions erode operator trust and can exhaust server resources.

**Dependencies.** None.

**Key architectural decisions.**
- Implement proper `destroy()` handling on the transform stream to clean up upstream connections.
- Add timeout detection: if no chunk arrives within a configurable window (default 30s), emit an error event and close the stream.
- Add integration tests that simulate upstream disconnects and client aborts.

---

### 1.7 Portal UX Improvements (#115)

**What it is.** Polish the Portal self-service UI: improve onboarding flow, add inline API key copy, show agent configuration previews, and add a getting-started wizard for new tenants.

**Why it matters.** The Portal is the first thing a new user sees. A rough onboarding experience creates friction that prevents adoption. Early beta feedback has highlighted specific pain points around key management and agent setup.

**Dependencies.** API key expiry (#111) should land first so the Portal can expose rotation and expiry controls.

**Key architectural decisions.**
- The wizard is a client-side multi-step form that calls existing Portal API endpoints — no new backend routes required.
- Agent configuration preview renders the merged system prompt (base + skills) so users can see exactly what the LLM will receive.

---

### 1.8 Error Handling Standardization (#116)

**What it is.** Define a canonical error response format across all API surfaces (gateway, portal, admin, dashboard) with structured error codes, human-readable messages, and correlation IDs.

**Why it matters.** Inconsistent error formats force SDK authors and integrators to handle multiple shapes. A standard format simplifies debugging and enables structured alerting.

**Dependencies.** None.

**Key architectural decisions.**
- Error response schema: `{ error: { code: string, message: string, correlation_id: string, details?: object } }`.
- Gateway errors map provider-specific error formats to the canonical schema.
- Correlation ID is generated per request and included in both the response and the trace record.

---

### 1.9 Documentation and Developer Guide Refresh (#117)

**What it is.** Update all documentation to reflect current architecture, add quickstart guides for each provider, and publish an OpenAPI spec for the gateway and management APIs.

**Why it matters.** Documentation is the product for developer tools. Outdated docs erode trust faster than bugs. An OpenAPI spec enables code generation for client SDKs.

**Dependencies.** Multi-provider expansion (#110) and API key expiry (#111) should land first so docs reflect the complete feature set.

**Key architectural decisions.**
- OpenAPI spec generated from Fastify route schemas using `@fastify/swagger`.
- Docs hosted alongside the project (in `docs/`) and published to a static site.

---

## Phase 2: Production Ready

**Timeline:** April through June 2026
**Theme:** Enterprise-grade security, broader provider coverage, and operator tooling.

Phase 2 targets the requirements that enterprise early adopters will gate their production deployments on: audit logging, role-based access control, cost visibility, and the remaining major LLM providers.

### 2.1 Audit Logging (#118)

**What it is.** Record a tamper-evident log of all administrative actions (tenant creation, API key operations, agent configuration changes, user role assignments) with actor identity, timestamp, action type, and before/after state.

**Why it matters.** Audit logs are a hard requirement for SOC 2 Type II, HIPAA, and most enterprise security reviews. Without them, operators cannot answer "who changed what, when" — a question that every security incident triggers.

**Dependencies.** EntityManager forking (#109) — audit log writes must be part of the request-scoped unit of work.

**Key architectural decisions.**
- Audit events stored in a dedicated `audit_log` table, partitioned by month (same strategy as traces).
- Events are append-only; no update or delete operations on the audit log.
- Sensitive fields (API key values, encryption keys) are redacted before logging.
- Queryable via Admin API with filtering by actor, action type, and time range.

---

### 2.2 Anthropic and Google Providers (#119)

**What it is.** Production-quality adapters for Anthropic Claude and Google Gemini, building on the initial implementations from Phase 1.

**Why it matters.** Anthropic and Google represent the second and third largest LLM providers by enterprise adoption. Production-quality means complete streaming support, accurate token counting, cost calculation, and error mapping.

**Dependencies.** Multi-provider expansion (#110) delivers initial adapters; this issue covers hardening to production quality.

**Key architectural decisions.**
- Anthropic adapter handles the `messages` API format, including system message extraction (Anthropic uses a top-level `system` field rather than a system message in the array).
- Google adapter handles the Gemini `generateContent` / `streamGenerateContent` endpoints with content-part mapping.
- Both adapters must handle rate-limit responses (429) and map them to Arachne's retry/backoff guidance format.

---

### 2.3 Role-Based Access Control (#120)

**What it is.** Implement granular permissions beyond the current `owner` / `member` roles. Define permissions for agent management, API key operations, knowledge base management, trace access, and billing/cost visibility.

**Why it matters.** Multi-user tenants need to restrict who can create API keys, modify agents, or view traces. Without RBAC, every team member has full access — an unacceptable risk for enterprise deployments.

**Dependencies.** Audit logging (#118) — role changes should be audited.

**Key architectural decisions.**
- Permission model: roles are named collections of permissions (e.g., `agent-admin`, `viewer`, `billing-admin`).
- Permissions checked at the route handler level via a `requirePermission('agents:write')` guard.
- Custom roles stored per-tenant; built-in roles (`owner`, `admin`, `member`, `viewer`) are immutable.
- JWT payload includes role; permission resolution happens server-side against the role definition.

---

### 2.4 Cost Dashboard (#121)

**What it is.** A real-time cost tracking and visualization system that calculates per-request costs based on provider pricing, aggregates by tenant/agent/model/time period, and displays trends in the Dashboard UI.

**Why it matters.** LLM costs are the primary operational concern for teams scaling AI features. Without visibility, teams cannot budget, detect anomalies, or compare provider economics.

**Dependencies.** Multi-provider expansion (#110) — cost calculation requires provider-specific pricing tables.

**Key architectural decisions.**
- Pricing data maintained in a `provider_pricing` table with per-model input/output token rates.
- Cost calculated at trace recording time and stored as a field on the trace record.
- Dashboard aggregation uses the existing analytics engine with new cost-specific queries.
- Supports cost alerts: configurable thresholds that trigger webhook notifications when daily/weekly spend exceeds limits.

---

### 2.5 Interactive Playground (#122)

**What it is.** A browser-based chat interface in the Dashboard that lets operators test agents, adjust parameters (temperature, top_p, model), and inspect the full request/response cycle including system prompt injection, RAG context, and conversation memory.

**Why it matters.** Developers need a fast feedback loop when building agents. Today, testing requires curl or an SDK. A built-in playground reduces the edit-test cycle from minutes to seconds and makes agent behavior visible.

**Dependencies.** Portal UX improvements (#115) — shares UI components.

**Key architectural decisions.**
- The playground calls the same `/v1/chat/completions` endpoint that external clients use — no special backend routes.
- Parameter controls are client-side; the playground constructs the request payload and displays the raw SSE stream.
- A "debug panel" shows the resolved system prompt (after agent application), injected RAG context, and conversation history.
- Playground sessions are not persisted (ephemeral by default), but can optionally create real conversations.

---

### 2.6 Webhook System (#123)

**What it is.** A configurable webhook delivery system that notifies external services of key events: trace completion, cost threshold exceeded, API key expiry approaching, agent configuration changes.

**Why it matters.** Operators need to integrate Arachne with their existing monitoring, alerting, and workflow systems (PagerDuty, Slack, custom dashboards). Webhooks are the standard integration pattern for event-driven architectures.

**Dependencies.** Audit logging (#118) — some webhook events mirror audit events.

**Key architectural decisions.**
- Webhook subscriptions configured per-tenant via Portal API.
- Delivery uses a background queue with exponential backoff retry (3 attempts, 1s/10s/60s).
- Payloads signed with HMAC-SHA256 using a per-subscription secret, following the GitHub webhook signature pattern.
- Failed deliveries logged with response status and body for debugging.

---

## Phase 3: Differentiation

**Timeline:** June through September 2026
**Theme:** Features that set Arachne apart from commodity API proxies.

Phase 3 moves Arachne from "a good gateway" to "the platform you build AI products on." These features — agent evals, hybrid search, intelligent model routing, and advanced memory — create switching costs and genuine product differentiation.

### 3.1 Agent Evaluation Framework (#124)

**What it is.** A built-in system for defining evaluation suites (test cases with expected outputs), running them against agents, and tracking quality metrics over time. Supports exact match, semantic similarity, LLM-as-judge, and custom scoring functions.

**Why it matters.** Teams shipping AI features need regression testing. Today, there is no standard way to verify that an agent configuration change did not degrade quality. Evals close the loop between development and production monitoring.

**Dependencies.** Comprehensive test suite (#113) — the eval framework builds on the testing infrastructure.

**Key architectural decisions.**
- Eval suites defined as YAML artifacts in the registry (same artifact lifecycle as agents and knowledge bases).
- Eval runs execute via the gateway (real provider calls), with results stored in a dedicated `eval_runs` table.
- Scoring functions are pluggable: built-in scorers for common patterns, with a JavaScript function interface for custom logic.
- Dashboard visualizes eval trends: pass rate, score distributions, regression alerts.
- Eval runs can be triggered via API (for CI/CD integration) or manually from the Dashboard.

---

### 3.2 Hybrid Search for RAG (#125)

**What it is.** Extend the RAG retrieval pipeline to combine vector similarity search (pgvector) with BM25 full-text search, using reciprocal rank fusion to merge results.

**Why it matters.** Pure vector search misses exact keyword matches (product names, error codes, technical terms). Pure keyword search misses semantic relationships. Hybrid search captures both, measurably improving retrieval quality for technical and domain-specific knowledge bases.

**Dependencies.** None — the existing RAG pipeline (`src/rag/retrieval.ts`) is the integration point.

**Key architectural decisions.**
- BM25 search uses PostgreSQL's built-in `tsvector` / `tsquery` full-text search — no additional infrastructure.
- Reciprocal rank fusion weights are configurable per knowledge base (default: 0.5 vector / 0.5 keyword).
- Chunk ingestion pipeline updated to generate both embeddings and tsvector representations.
- Retrieval metrics (vector score, BM25 score, fused rank) recorded in trace for quality analysis.

---

### 3.3 Intelligent Model Routing (#126)

**What it is.** Automatic model selection based on request characteristics: complexity estimation, token budget, latency requirements, and cost constraints. Operators define routing policies; Arachne selects the optimal model per request.

**Why it matters.** Not every request needs GPT-4. Simple classification tasks can run on smaller, cheaper, faster models. Intelligent routing can reduce costs by 40-60% without measurable quality degradation for many workloads.

**Dependencies.** Cost dashboard (#121) — routing decisions should be informed by cost data. Multi-provider expansion (#110) — routing across providers requires multiple adapters.

**Key architectural decisions.**
- Routing policies defined per-agent as a decision tree: conditions (estimated tokens, user tier, time of day) map to model selections.
- Complexity estimation uses a lightweight classifier (token count heuristics + keyword patterns) — not an LLM call.
- Fallback chain: if the selected model fails or is rate-limited, try the next model in the policy.
- Routing decisions recorded in trace metadata for cost/quality analysis.

---

### 3.4 Advanced Memory Strategies (#127)

**What it is.** Extend conversation memory beyond the current sliding-window-with-summarization approach to support multiple strategies: sliding window, summarization, entity extraction, and hybrid approaches. Strategies are configurable per agent.

**Why it matters.** Different use cases need different memory approaches. A customer support agent needs entity persistence (customer name, order number). A coding assistant needs recent context verbatim. A research agent needs topic-based retrieval. One-size-fits-all memory limits what agents can do.

**Dependencies.** EntityManager forking (#109) — memory operations are request-scoped.

**Key architectural decisions.**
- Memory strategies implement a `MemoryStrategy` interface with `load(conversationId): Message[]` and `store(conversationId, messages): void`.
- Entity extraction strategy uses the LLM to extract key-value pairs from conversations, stored in a `conversation_entities` table.
- Hybrid strategy combines sliding window (recent messages) with entity retrieval (persistent facts).
- Strategy selection configured per-agent in the agent definition YAML.

---

### 3.5 Custom Metrics and Observability (#128)

**What it is.** Allow operators to define custom metrics extracted from request/response payloads (sentiment, topic classification, response quality scores) and expose them in the analytics engine.

**Why it matters.** Token counts and latency are table stakes. Teams need domain-specific metrics — "was the customer satisfied?", "did the agent hallucinate?", "what topic was discussed?" — to operate AI features effectively.

**Dependencies.** Agent evaluation framework (#124) — custom metrics can feed into eval scoring.

**Key architectural decisions.**
- Custom metric extractors defined as JavaScript functions that receive the request/response pair and return a numeric or categorical value.
- Extractors run asynchronously after response completion (same fire-and-forget pattern as trace recording).
- Metrics stored in a `custom_metrics` table linked to trace records.
- Dashboard analytics engine extended to aggregate and visualize custom metrics.

---

## Phase 4: Ecosystem

**Timeline:** September 2026 through March 2027
**Theme:** Community, extensibility, and enterprise readiness.

Phase 4 transforms Arachne from a product into a platform. The marketplace, plugin system, SSO, and data residency features unlock enterprise procurement and community-driven growth.

### 4.1 Agent and Knowledge Base Marketplace (#129)

**What it is.** A public registry where users can publish, discover, and deploy agent definitions and knowledge base artifacts. Includes versioning, search, ratings, and usage analytics.

**Why it matters.** Marketplaces create network effects. Every published agent makes the platform more valuable for every user. Reusable knowledge bases (compliance, technical docs, industry knowledge) save teams weeks of setup time.

**Dependencies.** Registry API (`src/routes/registry.ts`) — the marketplace extends the existing artifact registry with public visibility and discovery.

**Key architectural decisions.**
- Public artifacts are a new visibility level in the registry (current: tenant-private).
- Marketplace search uses PostgreSQL full-text search over artifact metadata (name, description, tags).
- "Deploy" creates a copy of the artifact in the user's tenant — no shared mutable state.
- Usage analytics (deploy count, active instances) tracked per artifact for ranking and discovery.
- Content moderation: published artifacts require review before public listing (manual initially, automated later).

---

### 4.2 Plugin System (#130)

**What it is.** A runtime extension mechanism that allows operators to inject custom logic at defined hook points in the request lifecycle: pre-auth, pre-proxy, post-proxy, pre-trace, and custom tool handlers.

**Why it matters.** Every organization has unique requirements — custom auth schemes, content filtering, PII redaction, compliance checks. A plugin system lets teams extend Arachne without forking the codebase.

**Dependencies.** Error handling standardization (#116) — plugins need consistent error propagation.

**Key architectural decisions.**
- Plugins are JavaScript/TypeScript modules that export hook functions.
- Plugins loaded at startup from a configured directory or npm packages.
- Hook execution is synchronous within the request lifecycle (plugins can modify the request/response).
- Plugins have access to a sandboxed API surface — they cannot access the database directly, only through provided service interfaces.
- Plugin configuration stored per-tenant, allowing different tenants to enable different plugins.

---

### 4.3 SSO and Enterprise Identity (#131)

**What it is.** SAML 2.0 and OIDC integration for the Portal and Admin UIs, allowing enterprise users to authenticate via their corporate identity provider (Okta, Azure AD, Google Workspace).

**Why it matters.** Enterprise procurement requires SSO. Without it, Arachne cannot be deployed in organizations with mandatory identity federation policies. SSO is consistently the number-one feature request from enterprise prospects.

**Dependencies.** RBAC (#120) — SSO users need to be mapped to roles.

**Key architectural decisions.**
- SSO configured per-tenant: each tenant can connect their own IdP.
- SAML/OIDC handling uses the `passport` library with `passport-saml` and `openid-client` strategies.
- First-time SSO login auto-provisions a user account and tenant membership.
- Role mapping: IdP group claims map to Arachne roles via configurable rules.
- JWT issuance remains internal — SSO authenticates the user, Arachne issues its own session JWT.

---

### 4.4 Data Residency and Multi-Region (#132)

**What it is.** Support for deploying Arachne with data isolation by geographic region. Tenant data (traces, conversations, knowledge bases) stays within the configured region. Control plane metadata can be centralized or distributed.

**Why it matters.** GDPR, data sovereignty laws, and enterprise data residency requirements are non-negotiable for European and regulated-industry customers. Without region-aware data handling, Arachne cannot serve these markets.

**Dependencies.** Audit logging (#118) — region assignment is an auditable administrative action.

**Key architectural decisions.**
- Region is a tenant-level configuration: `tenant.data_region = 'eu-west-1' | 'us-east-1' | ...`.
- Each region has its own PostgreSQL instance. The control plane routes queries to the correct database based on tenant region.
- Cross-region queries (e.g., global admin analytics) use read replicas or federated queries.
- Migration tooling for moving a tenant between regions (with downtime window).
- Provider routing can be region-aware: prefer providers with endpoints in the tenant's data region.

---

### 4.5 Open Spec Governance (#133)

**What it is.** Establish a formal governance process for the Arachne open spec (agent definitions, knowledge base schemas, artifact formats). Move from single-maintainer to community-driven RFC process with versioned spec releases.

**Why it matters.** An open spec is only valuable if the community trusts it will remain open and stable. Governance signals long-term commitment and invites contributions from organizations building on the spec.

**Dependencies.** All previous phases — the spec should be stable before formalizing governance.

**Key architectural decisions.**
- Spec versioning follows semantic versioning (major.minor.patch).
- Changes proposed via RFCs (Request for Comments) in a dedicated repository.
- A steering committee (initially Arachne maintainers + 2-3 early adopter representatives) approves spec changes.
- Backward compatibility guaranteed within major versions.
- Reference implementations maintained for each spec version.

---

## Competitive Landscape

### OpenAI Assistants API

**Strengths:** First-party integration with GPT models, built-in file search and code interpreter, managed infrastructure.
**Weaknesses:** OpenAI-only (complete vendor lock-in), opaque pricing for assistant features, no self-hosting, limited customization.
**Arachne's advantage:** Provider-agnostic, self-hostable, transparent cost tracking, full data ownership.

### AWS Bedrock Agents

**Strengths:** Deep AWS integration, IAM-based security, access to multiple model providers within AWS.
**Weaknesses:** AWS-only deployment, complex IAM configuration, limited observability, no open spec.
**Arachne's advantage:** Cloud-agnostic, simpler multi-tenant model, built-in conversation memory and RAG, open-source.

### LangServe / LangChain

**Strengths:** Rich ecosystem of integrations, large community, flexible chain composition.
**Weaknesses:** Framework-heavy (application code depends on LangChain abstractions), no built-in multi-tenancy, no managed observability, primarily a library rather than a runtime.
**Arachne's advantage:** Runtime rather than library (zero application-code dependency), built-in multi-tenancy and encryption, managed observability pipeline.

### Portkey

**Strengths:** Excellent observability, multi-provider support, caching and fallback.
**Weaknesses:** SaaS-only (no self-hosting), no agent lifecycle management, no knowledge base / RAG support, no open spec.
**Arachne's advantage:** Self-hostable, complete agent lifecycle (define, version, deploy, evaluate), built-in RAG, open spec for portability.

---

## Arachne's Moat

Four interlocking advantages create defensibility that deepens with adoption:

### 1. Open Spec for Portable Agents

Agent definitions, knowledge base schemas, and artifact formats are defined by an open specification. Agents built for Arachne are not locked to Arachne — they can be deployed on any runtime that implements the spec. This counter-intuitive openness builds trust and accelerates adoption: teams adopt Arachne because they know they can leave, and then they stay because the platform delivers value.

### 2. Multi-Tenant Encryption by Default

Every piece of tenant data — traces, conversations, knowledge base chunks, provider keys — is encrypted at rest with per-tenant derived keys (AES-256-GCM with HMAC-SHA256 key derivation). This is not an add-on or enterprise feature; it is the default architecture. Retrofitting encryption into a system not designed for it is prohibitively expensive, which means competitors without it face a structural disadvantage in regulated markets.

### 3. Artifact Lifecycle Management

Agents and knowledge bases are versioned artifacts with a full lifecycle: define (YAML/JSON), validate, publish to registry, deploy to tenants, evaluate, and iterate. The CLI (`arachne weave`, `arachne push`, `arachne deploy`) provides a git-like workflow for agent development. This lifecycle is unique to Arachne — other platforms treat agents as configuration, not artifacts.

### 4. Provider-Agnostic by Architecture

The `BaseProvider` abstract class and adapter pattern mean that adding a new LLM provider requires implementing a single class with a `proxy()` method. The gateway, conversation memory, RAG pipeline, tracing, and analytics are all provider-independent. This architectural decision, made at the foundation, compounds in value as the provider landscape fragments.

---

## Success Metrics per Phase

### Phase 1: Beta Hardening (Now — mid-April 2026)

| Metric | Target |
|--------|--------|
| Test coverage (line) | >= 80% across core modules |
| Gateway p99 latency overhead | < 20ms |
| Supported providers | 7 (up from 3) |
| Zero data-corruption incidents from EM sharing | 0 incidents post-fork |
| API key expiry adoption | 50%+ of active keys have expiry set |

### Phase 2: Production Ready (April — June 2026)

| Metric | Target |
|--------|--------|
| Audit log completeness | 100% of administrative actions logged |
| RBAC adoption | 60%+ of multi-user tenants use custom roles |
| Cost dashboard accuracy | Within 5% of actual provider invoices |
| Playground usage | 40%+ of active operators use playground weekly |
| Webhook delivery success rate | >= 99.5% first-attempt delivery |

### Phase 3: Differentiation (June — September 2026)

| Metric | Target |
|--------|--------|
| Eval suite adoption | 30%+ of agents have at least one eval suite |
| Hybrid search retrieval quality | 15%+ improvement in recall@10 vs. vector-only |
| Cost reduction from model routing | 30%+ average cost reduction for opted-in tenants |
| Custom metrics defined | Average 3+ custom metrics per active tenant |

### Phase 4: Ecosystem (September 2026 — March 2027)

| Metric | Target |
|--------|--------|
| Marketplace artifacts published | 100+ public artifacts |
| SSO-enabled tenants | 50%+ of enterprise tenants |
| Plugin ecosystem | 10+ community-contributed plugins |
| Open spec contributors | 20+ external contributors to spec RFCs |
| Data residency regions | 3+ supported regions |

---

## Risks and Mitigations

### Phase 1 Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| EM forking introduces performance regression | Medium | Medium | Benchmark before/after; forking is lightweight (identity map copy, not data copy) |
| Provider API changes break adapters | Medium | High | Pin provider SDK versions; add integration tests against live APIs in CI (nightly) |
| Test suite effort delays feature work | Low | Medium | Parallelize: dedicate one contributor to tests while others build features |

### Phase 2 Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| RBAC complexity slows development velocity | Medium | Medium | Start with a small permission set (8-10 permissions); expand based on user feedback |
| Cost calculation accuracy varies by provider | Medium | High | Use provider billing APIs for reconciliation; clearly label estimates vs. actuals |
| Audit log volume overwhelms storage | Low | Low | Monthly partitioning (same as traces); configurable retention policy |

### Phase 3 Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Agent eval framework is too complex for adoption | High | Medium | Ship with 3-5 pre-built eval templates; provide a "one-click eval" for common patterns |
| Intelligent routing degrades quality | High | Medium | Require explicit opt-in; provide A/B comparison tooling; conservative default policies |
| Hybrid search adds latency to RAG pipeline | Medium | Low | BM25 on PostgreSQL is fast (< 5ms for typical knowledge bases); benchmark and set latency budget |

### Phase 4 Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Marketplace content quality control | High | Medium | Manual review for initial launches; invest in automated scanning for Phase 4.5 |
| SSO implementation complexity (SAML edge cases) | Medium | High | Use battle-tested libraries (passport-saml); start with OIDC (simpler), add SAML second |
| Open spec governance discourages contributions | Medium | Medium | Lightweight RFC process (GitHub discussions, not formal committee meetings); fast turnaround on proposals |
| Data residency increases operational complexity | High | Medium | Start with 2 regions; automate deployment with Terraform/Pulumi; dedicated runbook per region |

---

## Blog Entry

### Arachne 2026 Roadmap: From Beta to Ecosystem

We started Arachne with a simple observation: teams building AI features are drowning in integration work. Every LLM provider has its own API, auth model, and billing. Switching providers means rewriting application code. Observability is an afterthought. Multi-tenancy is a nightmare you build yourself.

Arachne exists to solve this. A single runtime that proxies to any LLM provider, encrypts everything at rest, records every interaction for debugging and compliance, and manages the full lifecycle of agents and knowledge bases — from YAML definition to production deployment.

Today we are sharing our product roadmap for the next twelve months, and we want to be transparent about where we are, where we are going, and why each step matters.

**Where we are today.** Arachne is in private beta. The gateway handles streaming and non-streaming completions across OpenAI, Azure OpenAI, and Ollama. Conversation memory persists multi-turn interactions with automatic summarization when token limits are reached. RAG retrieval injects relevant knowledge base chunks into prompts. The Portal gives tenants self-service control over agents, API keys, and knowledge bases. The Dashboard gives operators visibility into traces, analytics, and usage patterns. Every piece of tenant data is encrypted at rest with per-tenant derived keys.

It works. But "works" is not the same as "production-ready."

**Phase 1 (now through mid-April): Beta Hardening.** We are fixing the foundation. Request-scoped EntityManager forking eliminates a class of concurrency bugs. API key expiry and rotation enable the key hygiene that production deployments require. We are expanding from three to seven LLM providers — adding Anthropic, Google, AWS Bedrock, and Mistral. The provider bridge adapter lets you connect to any OpenAI-compatible endpoint without waiting for us to ship a dedicated adapter. And we are building a comprehensive test suite targeting 80%+ coverage across core modules.

**Phase 2 (April through June): Production Ready.** This is where we earn the trust of enterprise early adopters. Audit logging creates a tamper-evident record of every administrative action — a hard requirement for SOC 2 and HIPAA. Role-based access control lets teams restrict who can create API keys, modify agents, or view traces. The cost dashboard gives operators real-time visibility into LLM spend by tenant, agent, and model. The interactive playground lets developers test agents in the browser with full visibility into system prompt injection, RAG context, and conversation history. And the webhook system integrates Arachne with existing monitoring and alerting infrastructure.

**Phase 3 (June through September): Differentiation.** This is where Arachne stops being "a good gateway" and becomes "the platform you build AI products on." Agent evaluations let teams define test suites and track quality metrics over time — regression testing for AI. Hybrid search combines vector similarity with BM25 keyword matching for measurably better RAG retrieval. Intelligent model routing automatically selects the optimal model for each request based on complexity, cost constraints, and latency requirements — we have seen 40-60% cost reductions in early experiments. Advanced memory strategies let agents maintain entity persistence, topic-based retrieval, and hybrid context windows. Custom metrics let operators extract domain-specific signals from every interaction.

**Phase 4 (September through March 2027): Ecosystem.** We are building for the long term. The marketplace lets users publish, discover, and deploy agents and knowledge bases. The plugin system lets teams extend Arachne with custom logic — content filtering, PII redaction, compliance checks — without forking the codebase. SSO integration (SAML and OIDC) unblocks enterprise procurement. Data residency support ensures tenant data stays within configured geographic regions. And we are formalizing governance of the open spec, moving from single-maintainer to community-driven RFC process.

**Why open matters.** We chose to build Arachne as an open-source project with an open specification for agent and knowledge-base definitions. This is a deliberate strategic decision, not idealism. Teams adopt platforms they can trust — and trust requires the ability to leave. Agents built for Arachne are portable. The spec is open. The code is open. We believe that building in the open makes Arachne stronger, not weaker, because it forces us to compete on product quality rather than lock-in.

We are looking for design partners — teams building AI features who want a runtime that handles the infrastructure so they can focus on the product. If that sounds like you, sign up for the beta at [arachne.dev](https://arachne.dev) or reach out directly.

The next twelve months are going to be exciting. We will share progress updates as each phase milestone lands.

*— The Arachne Team*
