# Arachne Feature Roadmap

> Last updated: 2026-03-15 | Author: Oracle (AI Systems Advisor)
>
> This document is the canonical reference for sprint planning. It catalogs every implemented capability, defines the full feature backlog organized by category, and recommends a sequenced implementation order.

---

## Part 1: Current Capabilities

Everything Arachne ships today, organized by domain.

### Gateway & Proxy
- OpenAI-compatible `/v1/chat/completions` endpoint
- Streaming (SSE) and non-streaming proxy modes
- SSE Transform that captures content for tracing without adding latency
- Gateway overhead target < 20ms via LRU-cached auth (1,000 entries)
- Provider-agnostic adapter pattern (`BaseProvider` abstract class)

### Provider Ecosystem
- **OpenAI** adapter (injects `stream_options.include_usage`)
- **Azure OpenAI** adapter (maps error format, deployment routing)
- **Ollama** adapter (local/self-hosted models)
- Gateway-level provider management (CRUD, default selection, tenant availability)
- Provider entity hierarchy with STI (OpenAI, Azure, Ollama subtypes)
- Encrypted API key storage (`encrypted:{ciphertext}:{iv}` format)
- Provider cache with per-tenant eviction

### Agent System
- Agent definitions with system prompt, skills (tools), and MCP endpoints
- Merge policies for system prompts (`prepend`, `append`, `overwrite`, `ignore`)
- Merge policies for skills (`merge`, `overwrite`, `ignore`)
- MCP round-trip handling (one round-trip for non-streaming responses)
- Agent-to-API-key binding (each key resolves to one tenant + one agent)

### Artifact Registry
- Push/pull/delete artifacts via `/v1/registry/*`
- Artifact tagging (org/name:tag addressing)
- SHA-256 integrity verification on push
- Deployment provisioning (`/v1/registry/deployments`)
- Scoped JWT auth with permission system (`registry:push`, `artifact:read`, `deploy:write`)

### CLI (`@arachne/cli`)
- `arachne init` -- scaffold new agent/KB project
- `arachne weave` -- bundle agent/KB specs into `.orb` artifact
- `arachne push` -- publish artifact to registry
- `arachne deploy` -- provision artifact as live agent
- `arachne login` -- authenticate with gateway

### Conversation Memory
- Automatic conversation creation and resolution via `conversation_id`
- Partition support (`partition_id`) for conversation grouping
- Encrypted message storage (AES-256-GCM, per-tenant key derivation)
- Token budget tracking with configurable `conversation_token_limit`
- LLM-based summarization when budget exceeded (snapshot creation)
- History injection into request messages array

### RAG / Knowledge Bases
- Knowledge base artifact type with chunk storage (`kb_chunks` table)
- Embedding generation via configurable system embedder (OpenAI, Azure, Ollama)
- pgvector cosine similarity search
- Top-K retrieval with source attribution
- RAG context injection into system prompt
- RAG metrics in traces (retrieval latency, chunk count, similarity scores)
- Graceful fallback when RAG fails

### Observability & Analytics
- Batched trace recording (fire-and-forget, 5s / 100-row flush)
- Encrypted trace bodies (request + response)
- Analytics summary (total requests, tokens, cost, latency percentiles, error rate)
- Time-series metrics with configurable bucket size
- Per-model breakdown
- RAG-specific metrics (retrieval latency, failure rate, fallback rate)
- Gateway overhead and TTFB tracking
- Admin-level cross-tenant analytics

### Multi-Tenancy
- Subtenant hierarchy with `parent_id` tree
- Recursive CTE for inherited config resolution (provider, system prompt, skills)
- Per-tenant encryption key derivation (HMAC-SHA256)
- Tenant isolation on all queries
- Multi-user support with tenant memberships
- Tenant switching via JWT re-issuance

### Authentication & Security
- API key auth (SHA-256 hashed, LRU cached)
- Portal JWT auth (`PORTAL_JWT_SECRET`)
- Admin JWT auth (`ADMIN_JWT_SECRET`, 8-hour expiry)
- Registry JWT auth with scoped permissions
- AES-256-GCM encryption for all tenant data at rest
- API key soft revoke and hard delete

### Portal (Tenant Self-Service UI)
- User signup, login, profile management
- Tenant creation and management
- Agent CRUD with system prompt and skills editing
- API key management (create, list, revoke)
- Trace listing and detail view
- Analytics dashboard (summary, timeseries)
- Subtenant management
- Invite system
- Org slug support
- Beta signup flow with admin approval

### Admin Dashboard
- Admin login with password change (including first-login force)
- Tenant CRUD (create, list, detail, update status, delete)
- API key management per tenant
- Provider config management
- Cross-tenant trace listing
- Cross-tenant analytics (summary, timeseries, model breakdown)
- Gateway provider management (CRUD, default, tenant access)
- Beta signup management (list, approve)
- Settings management (signups enabled, default embedder)
- Smoke test management (list, detail, trigger)

### Infrastructure
- PostgreSQL 16 with pgvector extension
- MikroORM entity layer (in-progress migration from raw SQL)
- Monthly trace partitioning (`traces_YYYY_MM`)
- Docker Compose development setup
- Vitest test suite with SQLite driver option
- Playwright smoke tests
- GitHub Actions CI/CD
- Azure Container Apps deployment via Terraform

### Open Spec
- `arachne-ai.com/v0` API version for Agent, KnowledgeBase, and EmbeddingAgent specs
- YAML-based declarative agent/KB definitions
- `.orb` portable artifact format (gzipped bundles with SHA-256)

---

## Part 2: Feature Roadmap by Category

### 1. Agent Lifecycle

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 1.1 | Agent Evaluation Framework | P1 | 3 | L | [#124](../../issues/124) |
| 1.2 | Agent Versioning & Rollback | P1 | 2 | M | -- |
| 1.3 | A/B Testing for Agents | P2 | 3 | L | -- |
| 1.4 | Canary Deployments | P2 | 3 | M | -- |
| 1.5 | Agent Marketplace / Shared Registry | P2 | 4 | XL | [#129](../../issues/129) |
| 1.6 | Agent Templates | P3 | 3 | S | -- |
| 1.7 | Round-Trip Lifecycle Smoke Test | P1 | 1 | M | [#114](../../issues/114) |
| 1.8 | Deployment Environments (staging/production/dev) | P2 | 2 | M | [#98](../../issues/98) |
| 1.9 | `arachne run` for Deployment-Backed Agents | P2 | 2 | M | [#99](../../issues/99) |

**1.1 Agent Evaluation Framework**
A CLI command (`arachne eval`) and backend service that runs agent outputs against test suites with scored assertions (exact match, LLM-as-judge, regex, semantic similarity). Produces a report with pass/fail rates and regression detection. This is the foundation for quality-gated deployments and marketplace trust.
- **User Value:** Prevents regressions when updating agents; provides confidence scores before production promotion.
- **Dependencies:** Artifact registry (exists), CLI (exists). Benefits from agent versioning (1.2).

**1.2 Agent Versioning & Rollback**
Extend the artifact registry to track immutable version history per agent. Each `push` creates a new version rather than overwriting. Add `arachne rollback <agent> <version>` CLI command and portal UI for one-click rollback.
- **User Value:** Safe iteration -- any bad deploy can be undone in seconds.
- **Dependencies:** Artifact registry (exists), deployment provisioning (exists).

**1.3 A/B Testing for Agents**
Traffic splitting between two agent versions with configurable percentage. Traces are tagged with the variant label. Analytics can be filtered by variant for comparison.
- **User Value:** Data-driven agent improvement -- compare prompt changes, model swaps, or skill additions with real traffic.
- **Dependencies:** Agent versioning (1.2), analytics filtering (6.1).

**1.4 Canary Deployments**
Gradual rollout of a new agent version: 5% -> 25% -> 50% -> 100% with automatic rollback if error rate or latency exceeds thresholds. Configurable promotion criteria.
- **User Value:** Zero-downtime agent updates with automatic safety nets.
- **Dependencies:** Agent versioning (1.2), threshold alerting (6.2), A/B testing (1.3).

**1.5 Agent Marketplace / Shared Registry**
A public or org-scoped catalog where agents and knowledge bases can be published, discovered, and forked. Includes ratings, usage stats, and quality signals from evals.
- **User Value:** Accelerates adoption -- new tenants can start from proven agents instead of building from scratch.
- **Dependencies:** Evals (1.1) for quality signals, agent versioning (1.2), RBAC (8.2) for access control.

**1.6 Agent Templates**
Pre-built starter agents for common use cases (customer support, code assistant, document Q&A). Available via `arachne init --template <name>`.
- **User Value:** Reduces time-to-first-agent from hours to minutes.
- **Dependencies:** CLI (exists). Benefits from marketplace (1.5).

**1.7 Round-Trip Lifecycle Smoke Test**
End-to-end test that creates a tenant, pushes an agent, deploys it, sends a chat request, verifies the response, and tears down. Runs in CI and on-demand from the admin dashboard.
- **User Value:** Catches integration regressions that unit tests miss; validates the full deploy pipeline.
- **Dependencies:** Smoke test infrastructure (exists -- Playwright runner and admin endpoints).

**1.8 Deployment Environments**
Support for `staging`, `production`, and `dev` environments per agent. Each environment has its own provider config, API keys, and traffic. `arachne deploy --env staging` promotes an artifact to a specific environment.
- **User Value:** Standard software lifecycle -- test in staging before production.
- **Dependencies:** Deployment provisioning (exists).

**1.9 `arachne run` Command**
CLI command that starts a local interactive chat session against a deployed agent, useful for development and debugging.
- **User Value:** Rapid local iteration without switching to curl or Postman.
- **Dependencies:** CLI (exists), deployment provisioning (exists).

---

### 2. Compliance & Governance

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 2.1 | Audit Logging | P1 | 2 | L | [#118](../../issues/118) |
| 2.2 | Data Retention Policies | P2 | 2 | M | -- |
| 2.3 | PII Detection & Redaction | P2 | 3 | L | -- |
| 2.4 | Content Filtering / Guardrails | P2 | 3 | L | -- |
| 2.5 | Usage Quotas & Rate Limiting | P1 | 2 | M | -- |
| 2.6 | Data Residency & Compliance Certs | P3 | 4 | XL | [#132](../../issues/132) |
| 2.7 | Trace Export & SIEM Integration | P3 | 3 | M | -- |

**2.1 Audit Logging**
Immutable, append-only log of all administrative actions: tenant CRUD, API key operations, provider config changes, agent deployments, user role changes. Queryable via admin API with time/actor/action filters. Stored in a dedicated `audit_events` table.
- **User Value:** Required for SOC 2, ISO 27001, and enterprise procurement. Answers "who did what, when."
- **Dependencies:** Admin routes (exist). Should be implemented before enterprise sales begin.

**2.2 Data Retention Policies**
Configurable per-tenant policies for trace data, conversation history, and audit logs. Automatic purging via scheduled job. Supports `retain_days`, `retain_count`, and `retain_forever` modes.
- **User Value:** Compliance with GDPR "right to erasure" and data minimization principles; reduces storage costs.
- **Dependencies:** Trace partitioning (exists -- monthly). Audit logging (2.1) for tracking deletions.

**2.3 PII Detection & Redaction**
Pre-request and post-response hooks that scan message content for PII patterns (email, SSN, phone, credit card). Configurable actions: `log`, `redact`, `block`. Uses regex patterns with optional LLM classification for ambiguous cases.
- **User Value:** Prevents accidental data leakage to LLM providers; required for regulated industries (healthcare, finance).
- **Dependencies:** Streaming transform (exists). Must integrate into SSE pipeline without breaking latency guarantees.

**2.4 Content Filtering / Guardrails**
Configurable input/output guardrails per agent: topic restrictions, language filtering, response format validation. Supports regex rules, keyword blocklists, and LLM-as-judge classification.
- **User Value:** Brand safety and compliance -- ensures agents stay on-topic and within organizational policy.
- **Dependencies:** Agent system (exists). Benefits from PII detection (2.3) for shared scanning infrastructure.

**2.5 Usage Quotas & Rate Limiting**
Per-tenant and per-API-key limits on: requests/minute, tokens/day, cost/month. Configurable soft limits (warning) and hard limits (429 response). Dashboard widget showing usage vs. quota.
- **User Value:** Prevents runaway costs from misconfigured agents; enables usage-based billing models.
- **Dependencies:** Analytics (exists for aggregation). LRU cache (exists) for real-time enforcement.

**2.6 Data Residency & Compliance Certifications**
Region-aware deployment configuration ensuring data stays within specified geographic boundaries. Provider routing respects residency constraints. Documentation for SOC 2 Type II and GDPR compliance.
- **User Value:** Opens enterprise and government markets with strict data sovereignty requirements.
- **Dependencies:** Multi-region infrastructure, audit logging (2.1), data retention (2.2).

**2.7 Trace Export & SIEM Integration**
Export traces and audit events to external SIEM systems (Splunk, Datadog, Elastic) via webhook, S3 export, or OpenTelemetry protocol.
- **User Value:** Integrates Arachne into existing enterprise security monitoring workflows.
- **Dependencies:** Audit logging (2.1), trace system (exists).

---

### 3. Embedding & RAG

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 3.1 | Per-Agent Embedding Config | P2 | 2 | S | -- |
| 3.2 | Configurable Chunking Strategies | P2 | 2 | M | -- |
| 3.3 | Hybrid Search (BM25 + Vector) | P2 | 3 | L | [#125](../../issues/125) |
| 3.4 | Reranking (Cross-Encoder) | P2 | 3 | M | -- |
| 3.5 | Multi-Modal RAG | P3 | 4 | XL | -- |
| 3.6 | RAG Evaluation Metrics | P2 | 3 | M | -- |
| 3.7 | Incremental KB Updates | P1 | 2 | M | -- |
| 3.8 | KB Document Management UI | P1 | 2 | M | -- |

**3.1 Per-Agent Embedding Config**
Allow agents to specify their own embedding provider/model (overriding the system embedder) via `spec.embedder` in the agent manifest. Enables agents to use domain-specific embedding models.
- **User Value:** Better retrieval quality -- a medical agent can use a biomedical embedding model while a code agent uses a code-optimized one.
- **Dependencies:** System embedder (exists), agent spec (exists). Plumbing already partially in place via `EmbeddingAgentSpec`.

**3.2 Configurable Chunking Strategies**
Support multiple chunking modes in KB weave: `fixed` (token-count windows), `semantic` (paragraph/section boundaries), `recursive` (split on headers then paragraphs), and `code` (language-aware AST splitting). Configurable via `spec.chunking.strategy`.
- **User Value:** Dramatically improves retrieval quality -- different document types need different chunking.
- **Dependencies:** WeaveService (exists). The `chunking` field is already defined in `KnowledgeBaseSpec` but only supports `tokenSize` and `overlap`.

**3.3 Hybrid Search (BM25 + Vector)**
Add a BM25 full-text search index alongside pgvector. Combine scores with reciprocal rank fusion (RRF) or weighted linear combination. Configurable via `spec.retrieval.searchMode: 'vector' | 'bm25' | 'hybrid'`.
- **User Value:** Catches keyword-dependent queries that pure vector search misses (e.g., exact product names, error codes).
- **Dependencies:** pgvector search (exists). Requires `tsvector` column on `kb_chunks` and GIN index.

**3.4 Reranking (Cross-Encoder)**
After initial retrieval (vector or hybrid), pass top-N candidates through a cross-encoder model to rerank by relevance. Supports Cohere Rerank, Jina, or self-hosted cross-encoders.
- **User Value:** Significant retrieval precision improvement (typically 10-20% MRR gain) at modest latency cost.
- **Dependencies:** RAG retrieval pipeline (exists). Can be added as a post-retrieval step.

**3.5 Multi-Modal RAG**
Support image, PDF, and table content in knowledge bases. Use vision models for image captioning, PDF layout parsing, and table structure extraction before chunking.
- **User Value:** Unlocks RAG for document-heavy enterprises (contracts, technical drawings, research papers).
- **Dependencies:** Chunking strategies (3.2), KB document management (3.8).

**3.6 RAG Evaluation Metrics**
Automated evaluation of RAG quality: faithfulness (does the answer match the retrieved context?), relevancy (are the retrieved chunks relevant?), and coverage (does the KB contain the answer?). Integrates with the eval framework.
- **User Value:** Quantifies RAG pipeline quality and guides tuning of chunking, retrieval, and reranking parameters.
- **Dependencies:** Eval framework (1.1), RAG pipeline (exists).

**3.7 Incremental KB Updates**
Support adding, updating, and deleting individual documents in a knowledge base without re-embedding the entire corpus. Track document-level checksums for change detection.
- **User Value:** Keeps knowledge bases fresh without expensive full re-weave operations.
- **Dependencies:** KB chunk storage (exists), vector space tracking (exists via `VectorSpace` entity).

**3.8 KB Document Management UI**
Portal interface for uploading documents to a knowledge base, viewing chunk previews, monitoring embedding progress, and testing retrieval queries.
- **User Value:** Non-technical users can manage knowledge bases without CLI access.
- **Dependencies:** Portal (exists), registry (exists), incremental KB updates (3.7).

---

### 4. Provider Ecosystem

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 4.1 | Anthropic Claude Adapter | P1 | 2 | M | [#119](../../issues/119) |
| 4.2 | Google Gemini / Vertex AI Adapter | P1 | 2 | M | [#120](../../issues/120) |
| 4.3 | Model Routing & Fallback | P2 | 3 | L | [#126](../../issues/126) |
| 4.4 | Cost-Optimized Routing | P3 | 3 | M | -- |
| 4.5 | Provider Rate Limit Management | P2 | 2 | M | -- |
| 4.6 | Bridge Provider Entities to Proxy | P1 | 1 | M | [#113](../../issues/113) |
| 4.7 | Complete Multi-Provider Management | P1 | 1 | L | [#111](../../issues/111) |
| 4.8 | AWS Bedrock Adapter | P3 | 3 | M | -- |
| 4.9 | Provider Health Monitoring | P2 | 3 | S | -- |

**4.1 Anthropic Claude Adapter**
Native adapter for Anthropic's Messages API. Handles the different message format (no `system` role in messages -- system prompt goes in a separate field), streaming format differences, and tool use schema variations.
- **User Value:** Access to Claude models (Opus, Sonnet, Haiku) -- one of the top 3 LLM providers.
- **Dependencies:** Provider entity hierarchy (exists). Requires new `AnthropicProvider` entity subtype.

**4.2 Google Gemini / Vertex AI Adapter**
Adapter supporting both the public Gemini API and enterprise Vertex AI. Handles Google's content format (parts-based messages), safety settings, and OAuth2/service account authentication for Vertex.
- **User Value:** Access to Gemini models and enterprise GCP integration.
- **Dependencies:** Provider entity hierarchy (exists).

**4.3 Model Routing & Fallback**
Intelligent request routing: primary/fallback provider chains, model-based routing (route GPT requests to OpenAI, Claude requests to Anthropic), and automatic failover when a provider returns 5xx or times out.
- **User Value:** Production resilience -- no single provider outage takes down the application.
- **Dependencies:** Multiple provider adapters (4.1, 4.2), provider health monitoring (4.9).

**4.4 Cost-Optimized Routing**
Route requests to the cheapest provider that meets quality requirements. Uses model capability tiers (e.g., "this prompt only needs a small model") and real-time cost tracking to minimize spend while maintaining quality SLOs.
- **User Value:** Reduces LLM costs by 30-60% for workloads with mixed complexity.
- **Dependencies:** Model routing (4.3), cost dashboard (6.3), eval framework (1.1) for quality gating.

**4.5 Provider Rate Limit Management**
Track rate limits returned by providers (via response headers), implement client-side throttling, and distribute requests across providers to maximize throughput. Surface rate limit status in dashboard.
- **User Value:** Prevents 429 cascades and maximizes utilization of provider quotas.
- **Dependencies:** Provider adapters (exist). Provider health monitoring (4.9).

**4.6 Bridge Provider Entities to Proxy**
Connect the gateway provider entity system (MikroORM `ProviderBase` hierarchy) to the proxy adapter layer. Currently the `resolveGatewayProvider` function in the registry uses fragile sync identity-map lookups.
- **User Value:** Prerequisite for reliable multi-provider -- without this, gateway providers are not reliably resolved at proxy time.
- **Dependencies:** Provider entity hierarchy (exists), per-request EM forking (#110).

**4.7 Complete Multi-Provider Management (Stories 3-7)**
Finish the remaining stories: tenant custom provider management (portal UI), agent-level provider selection with model validation, tenant default provider selection, and agent portability across providers.
- **User Value:** Tenants can bring their own provider keys and switch between providers without admin intervention.
- **Dependencies:** Bridge provider entities (4.6), per-request EM forking (#110).

**4.8 AWS Bedrock Adapter**
Adapter for AWS Bedrock supporting Claude, Titan, Llama, and Mistral models via AWS SDK. Uses IAM role-based authentication.
- **User Value:** Enterprise AWS customers can route through their existing Bedrock agreements and compliance boundaries.
- **Dependencies:** Provider entity hierarchy (exists).

**4.9 Provider Health Monitoring**
Background health checks per provider: periodic lightweight requests, tracking error rates and latency trends, circuit breaker pattern for failing providers. Health status visible in admin dashboard.
- **User Value:** Enables automatic fallback routing; surfaces provider issues before they affect users.
- **Dependencies:** Provider adapters (exist).

---

### 5. Conversation Intelligence

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 5.1 | Advanced Memory Strategies | P2 | 3 | L | [#127](../../issues/127) |
| 5.2 | Configurable Summarization | P2 | 2 | S | -- |
| 5.3 | Cross-Conversation Search | P3 | 3 | L | -- |
| 5.4 | Conversation Branching | P3 | 4 | M | -- |
| 5.5 | Conversation Analytics | P2 | 2 | M | -- |
| 5.6 | Conversation Export | P3 | 2 | S | -- |

**5.1 Advanced Memory Strategies**
Beyond the current "summarize on token overflow" approach: sliding window (keep last N messages), entity memory (extract and persist key facts), hierarchical summarization (multi-level summaries at different granularities), and hybrid strategies combining multiple approaches.
- **User Value:** Different use cases need different memory trade-offs -- customer support needs entity memory, creative writing needs full context, analytics bots need sliding window.
- **Dependencies:** Conversation management service (exists). Each strategy requires a new `MemoryStrategy` implementation.

**5.2 Configurable Summarization**
Allow agents to specify the summarization model, prompt template, and trigger conditions (token count, message count, time-based). Support custom summarization prompts for domain-specific context compression.
- **User Value:** Better summaries mean less context loss -- a legal agent needs different summarization than a casual chatbot.
- **Dependencies:** Conversation management service (exists). The `conversation_summary_model` field already exists.

**5.3 Cross-Conversation Search**
Search across all conversations for a tenant using full-text and semantic search. Find previous interactions about a topic, retrieve how the agent handled similar questions before.
- **User Value:** Knowledge mining -- discover patterns, find edge cases, and build training data from real conversations.
- **Dependencies:** Conversation storage (exists). Requires decryption-at-query-time or a search-optimized index.

**5.4 Conversation Branching**
Fork a conversation at any point to explore alternative paths. Useful for "what if" scenarios and agent debugging.
- **User Value:** Debug agent behavior by replaying conversations with different parameters.
- **Dependencies:** Conversation management (exists), conversation snapshot system (exists).

**5.5 Conversation Analytics**
Metrics on conversation patterns: average conversation length, user satisfaction signals, topic distribution, resolution rates, handoff rates. Aggregate by agent, tenant, and time period.
- **User Value:** Understand how agents are performing in real conversations; identify improvement opportunities.
- **Dependencies:** Conversation storage (exists), analytics infrastructure (exists).

**5.6 Conversation Export**
Export conversation history in standard formats (JSON, CSV, JSONL) for training, analysis, or compliance. Includes metadata and can be filtered by date range, agent, or partition.
- **User Value:** Feed real conversations into fine-tuning pipelines or external analytics tools.
- **Dependencies:** Conversation storage (exists), encryption/decryption (exists).

---

### 6. Observability & Analytics

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 6.1 | Custom Metrics & Dimensions | P2 | 3 | M | -- |
| 6.2 | Threshold Alerting | P2 | 3 | L | [#128](../../issues/128) |
| 6.3 | Cost Dashboard | P2 | 2 | M | [#122](../../issues/122) |
| 6.4 | SLO Definitions & Tracking | P3 | 3 | M | -- |
| 6.5 | Latency Heatmaps | P3 | 3 | S | -- |
| 6.6 | Real-Time Stream Dashboard | P3 | 3 | M | -- |
| 6.7 | Analytics Data Strategy (Star Schema) | P3 | 1 | L | [#117](../../issues/117) |
| 6.8 | Trace Detail View with Decrypted Bodies | P1 | 2 | S | -- |

**6.1 Custom Metrics & Dimensions**
Allow tenants to attach custom key-value dimensions to traces (e.g., `user_tier: premium`, `feature: code_review`). Analytics queries can group/filter by these dimensions.
- **User Value:** Business-specific analytics -- slice data by customer segment, feature flag, or experiment ID.
- **Dependencies:** Trace system (exists). Requires a JSONB `metadata` column on traces.

**6.2 Threshold Alerting**
Configurable alerts when metrics cross thresholds: error rate > 5%, p95 latency > 3s, cost > $100/day, RAG failure rate > 10%. Delivers via webhook, email, or Slack integration.
- **User Value:** Proactive incident detection -- know about problems before users report them.
- **Dependencies:** Analytics infrastructure (exists). Requires a background monitoring loop and notification delivery.

**6.3 Cost Dashboard**
Detailed cost visualization with breakdown by tenant, agent, model, and time period. Shows cost trends, projected monthly spend, and budget alerts. Includes per-model pricing configuration for accurate cost estimation.
- **User Value:** Cost visibility and control -- essential for any production deployment with multiple tenants.
- **Dependencies:** Analytics (exists -- cost estimation SQL already in place). Needs expanded pricing tables and UI.

**6.4 SLO Definitions & Tracking**
Define service level objectives per agent or tenant: "99th percentile latency < 2s", "error rate < 1%", "availability > 99.9%". Track SLO burn rate and display on dashboard.
- **User Value:** Formal reliability commitments; enables SLA-backed enterprise offerings.
- **Dependencies:** Analytics infrastructure (exists), alerting (6.2).

**6.5 Latency Heatmaps**
Visual heatmap of request latency by time-of-day and day-of-week. Helps identify patterns (e.g., slow responses during peak hours due to provider rate limits).
- **User Value:** Performance pattern recognition for capacity planning and provider quota management.
- **Dependencies:** Timeseries analytics (exists). Frontend-only feature.

**6.6 Real-Time Stream Dashboard**
Live-updating dashboard showing active requests, streaming completions, and recent traces as they arrive. Uses WebSocket or SSE for real-time updates.
- **User Value:** Operational awareness -- see what the gateway is doing right now.
- **Dependencies:** Trace system (exists). Requires WebSocket server and frontend components.

**6.7 Analytics Data Strategy (Star Schema)**
Design and implement a star schema or analytics-optimized data store for traces at scale. Current approach (querying the `traces` table directly) will not scale past ~10M traces.
- **User Value:** Maintains sub-second analytics as data grows; foundation for all advanced analytics features.
- **Dependencies:** Research task. Inform the decision before building cost dashboard (6.3) at scale.

**6.8 Trace Detail View with Decrypted Bodies**
Portal and dashboard UI for viewing full trace details including decrypted request/response bodies. Currently traces are listed but bodies are encrypted and not viewable.
- **User Value:** Debugging and QA -- see exactly what was sent to and received from the LLM for any request.
- **Dependencies:** Trace system (exists), decryption (exists).

---

### 7. Developer Experience

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 7.1 | TypeScript/Python SDK | P1 | 2 | L | -- |
| 7.2 | Local Dev Mode | P2 | 2 | M | -- |
| 7.3 | Agent Playground | P2 | 2 | M | [#123](../../issues/123) |
| 7.4 | API Explorer / OpenAPI Spec | P2 | 2 | M | -- |
| 7.5 | Trace Debugging Tools | P2 | 3 | M | -- |
| 7.6 | `arachne doctor` Diagnostic Command | P3 | 2 | S | -- |
| 7.7 | Hot Reload for Agent Development | P3 | 3 | M | -- |

**7.1 TypeScript/Python SDK**
Client libraries that wrap the Arachne API with type-safe interfaces, automatic retry/backoff, streaming helpers, and conversation management. Published to npm and PyPI.
- **User Value:** Reduces integration time from hours to minutes; provides IDE autocomplete and type checking.
- **Dependencies:** Stable API surface (mostly exists). OpenAPI spec (7.4) informs SDK generation.

**7.2 Local Dev Mode**
`arachne dev` command that starts a local gateway with hot reload, auto-applies agent changes on save, and provides a built-in chat UI for testing. Uses SQLite and mock providers for zero-dependency local development.
- **User Value:** Fast iteration loop -- edit agent, test immediately, no deployment needed.
- **Dependencies:** CLI (exists), SQLite support (exists for tests).

**7.3 Agent Playground**
Interactive chat interface in the Portal UI where tenants can test agents with different models, temperature settings, and input prompts. Shows trace details alongside responses.
- **User Value:** Test and tune agents without writing code or using the CLI.
- **Dependencies:** Portal (exists), trace detail view (6.8).

**7.4 API Explorer / OpenAPI Spec**
Auto-generated OpenAPI 3.1 specification for all Arachne APIs. Includes an embedded Swagger UI at `/docs`. Serves as the single source of truth for SDK generation.
- **User Value:** Self-documenting API; enables third-party integrations without reading source code.
- **Dependencies:** Fastify routes (exist). Can use `@fastify/swagger`.

**7.5 Trace Debugging Tools**
Request replay (re-send a traced request to the same or different agent), diff view (compare two trace responses side-by-side), and request timeline visualization (auth -> RAG -> provider -> response).
- **User Value:** Debug production issues by replaying exact requests; compare agent versions on the same input.
- **Dependencies:** Trace detail view (6.8), agent versioning (1.2).

**7.6 `arachne doctor` Diagnostic Command**
CLI command that checks local environment health: Node.js version, database connectivity, provider reachability, API key validity, agent deployment status. Reports issues with suggested fixes.
- **User Value:** Self-service troubleshooting -- reduces support burden.
- **Dependencies:** CLI (exists).

**7.7 Hot Reload for Agent Development**
File watcher that automatically re-weaves and re-deploys agents when spec files change during development. Uses `arachne dev --watch`.
- **User Value:** Sub-second feedback loop for agent development.
- **Dependencies:** Local dev mode (7.2), weave service (exists).

---

### 8. Multi-Tenancy & Enterprise

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 8.1 | SAML 2.0 / OIDC SSO | P2 | 4 | L | [#131](../../issues/131) |
| 8.2 | Granular RBAC | P1 | 2 | L | [#121](../../issues/121) |
| 8.3 | Organization Management | P2 | 3 | M | -- |
| 8.4 | Billing & Metering | P2 | 3 | XL | -- |
| 8.5 | Team Workspaces | P3 | 3 | M | -- |
| 8.6 | Tenant Onboarding Wizard | P3 | 2 | M | -- |

**8.1 SAML 2.0 / OIDC SSO**
Enterprise SSO integration supporting SAML 2.0 and OpenID Connect. Tenants can configure their identity provider (Okta, Azure AD, Google Workspace) for user authentication. Includes JIT (just-in-time) user provisioning.
- **User Value:** Enterprise requirement -- no enterprise will adopt a tool that requires separate credentials.
- **Dependencies:** User management (exists), tenant memberships (exists).

**8.2 Granular RBAC**
Expand the current `owner`/`member` roles to `owner`/`admin`/`member`/`viewer` with fine-grained permissions: manage agents, manage API keys, view traces, manage members, manage billing. Permissions enforced at the API level.
- **User Value:** Least-privilege access control -- give developers agent access without exposing billing or member management.
- **Dependencies:** Portal auth (exists), tenant memberships (exists). Foundation for all enterprise features.

**8.3 Organization Management**
Multi-tenant organizations with centralized billing, shared providers, and cross-tenant visibility. An organization is a parent tenant with child tenants representing teams or projects.
- **User Value:** Enterprise structure -- a company with multiple teams can manage everything from one umbrella.
- **Dependencies:** Subtenant hierarchy (exists), RBAC (8.2).

**8.4 Billing & Metering**
Usage tracking and billing integration: per-token metering, per-request metering, Stripe integration for subscription and usage-based billing, invoice generation. Supports self-serve and invoice-based plans.
- **User Value:** Revenue generation -- critical for any commercial deployment.
- **Dependencies:** Usage quotas (2.5), cost dashboard (6.3), organization management (8.3).

**8.5 Team Workspaces**
Shared workspaces within a tenant for team-level agent management, shared knowledge bases, and team-scoped analytics. Members can belong to multiple workspaces.
- **User Value:** Organizational structure within a tenant -- marketing team and engineering team can have separate agent libraries.
- **Dependencies:** RBAC (8.2), organization management (8.3).

**8.6 Tenant Onboarding Wizard**
Guided setup flow for new tenants: configure provider, create first agent, test with playground, invite team members. Tracks completion percentage and highlights next steps.
- **User Value:** Reduces time-to-value for new tenants; decreases support requests for setup issues.
- **Dependencies:** Portal (exists), playground (7.3).

---

### 9. Security

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 9.1 | API Key Expiry & Rotation | P1 | 1 | M | [#112](../../issues/112) |
| 9.2 | mTLS for Provider Connections | P3 | 3 | M | -- |
| 9.3 | IP Allowlisting | P2 | 2 | S | -- |
| 9.4 | Secrets Management (KMS Integration) | P2 | 3 | L | -- |
| 9.5 | Per-Request EM Forking | P1 | 1 | M | [#110](../../issues/110) |
| 9.6 | Encryption Key Rotation | P2 | 2 | L | -- |
| 9.7 | Request Signing / HMAC Verification | P3 | 3 | S | -- |

**9.1 API Key Expiry & Rotation**
API keys with configurable expiration dates. Rotation workflow: create new key, grace period with both keys active, automatic revocation of old key. Dashboard shows expiring keys with warnings.
- **User Value:** Security hygiene -- credential rotation is a baseline enterprise requirement.
- **Dependencies:** API key system (exists). Requires `expires_at` column and a background expiry checker.

**9.2 mTLS for Provider Connections**
Mutual TLS authentication for connections to LLM providers and MCP endpoints. Useful for enterprise deployments where the provider is behind a corporate proxy.
- **User Value:** End-to-end encryption and authentication for the most security-sensitive deployments.
- **Dependencies:** Provider adapter layer (exists).

**9.3 IP Allowlisting**
Per-tenant configuration of allowed source IP ranges for API key usage. Requests from non-allowed IPs are rejected with 403.
- **User Value:** Defense in depth -- even if an API key is compromised, it can only be used from authorized networks.
- **Dependencies:** Auth middleware (exists).

**9.4 Secrets Management (KMS Integration)**
Replace application-level `ENCRYPTION_MASTER_KEY` with external KMS (AWS KMS, Azure Key Vault, GCP KMS, HashiCorp Vault). Per-tenant DEKs are wrapped by KMS CMKs. Supports automatic key rotation.
- **User Value:** Enterprise-grade key management; eliminates the risk of master key exposure in environment variables.
- **Dependencies:** Encryption module (exists). Architecture already supports this transition (noted in `encryption.ts` comments).

**9.5 Per-Request EntityManager Forking**
Fix the current EM forking approach to ensure complete tenant data isolation at the ORM level. Each request should get its own forked EM to prevent cross-tenant data leakage through MikroORM's identity map.
- **User Value:** Security correctness -- prevents one tenant's data from leaking to another through shared identity maps.
- **Dependencies:** MikroORM setup (exists). Prerequisite for many other features.

**9.6 Encryption Key Rotation**
Support rotating the master encryption key without downtime. Re-encrypt all tenant data (traces, conversations, provider keys) in background batches. Track encryption key version per record.
- **User Value:** Security compliance -- key rotation is required by most security frameworks.
- **Dependencies:** Encryption module (exists). The `encryption_key_version` field already exists on traces.

**9.7 Request Signing / HMAC Verification**
Optional HMAC signing for API requests to verify request integrity and prevent tampering. Useful for webhook callbacks and MCP endpoint communication.
- **User Value:** Additional integrity guarantee for sensitive operations.
- **Dependencies:** Auth middleware (exists).

---

### 10. Open Spec & Portability

| # | Feature | Priority | Phase | Complexity | GitHub |
|---|---------|----------|-------|------------|--------|
| 10.1 | Spec Versioning (v0 -> v1) | P1 | 2 | M | -- |
| 10.2 | Agent Import/Export | P2 | 2 | S | -- |
| 10.3 | Cross-Runtime Compatibility | P3 | 4 | XL | -- |
| 10.4 | Plugin System | P3 | 4 | XL | [#130](../../issues/130) |
| 10.5 | Open Spec Governance | P3 | 4 | M | [#133](../../issues/133) |
| 10.6 | Spec Validation & Linting | P2 | 2 | S | -- |

**10.1 Spec Versioning (v0 -> v1)**
Graduate the `arachne-ai.com/v0` spec to `v1` with a formal schema, JSON Schema validation, and migration tooling from v0 to v1. Establish versioning policy (backward compatibility guarantees, deprecation timeline).
- **User Value:** Stability contract -- users know their agent definitions will continue to work across upgrades.
- **Dependencies:** Current spec (exists at v0). Should be done before public launch.

**10.2 Agent Import/Export**
Export an agent (spec + knowledge base + deployment config) as a portable `.orb` bundle. Import into a different Arachne instance or different tenant. Includes provider mapping for cross-platform portability.
- **User Value:** Portability -- move agents between environments, share with partners, or migrate to a different Arachne deployment.
- **Dependencies:** Artifact registry (exists), agent spec (exists).

**10.3 Cross-Runtime Compatibility**
Define an abstract runtime interface so Arachne agent specs can be executed by alternative runtimes (e.g., a serverless runtime, an edge runtime, or a third-party AI gateway). Publish a reference implementation.
- **User Value:** No vendor lock-in -- the ultimate portability promise.
- **Dependencies:** Spec v1 (10.1), plugin system (10.4).

**10.4 Plugin System**
Extension points for custom providers, custom memory strategies, custom guardrails, and custom analytics processors. Plugins are npm packages that implement defined interfaces and are loaded at startup.
- **User Value:** Extensibility without forking -- the community can add capabilities without modifying core.
- **Dependencies:** Stable interfaces for providers (exists), memory (5.1), guardrails (2.4).

**10.5 Open Spec Governance**
Establish an open governance model for the Arachne spec: RFC process, community contributions, spec working group, public roadmap. Publish spec documentation as a standalone website.
- **User Value:** Community trust and adoption -- an open spec with transparent governance attracts contributors and enterprise adopters.
- **Dependencies:** Spec v1 (10.1).

**10.6 Spec Validation & Linting**
CLI command (`arachne lint`) that validates agent and KB spec files against the JSON Schema, checks for common errors, and suggests improvements. Integrated into `arachne weave` as a pre-build check.
- **User Value:** Catch errors before push -- better developer experience with actionable error messages.
- **Dependencies:** Spec v1 (10.1), CLI (exists).

---

## Part 3: Recommended Implementation Order

The top 20 features to build, in priority order, with rationale for sequencing.

| Rank | Feature | ID | Phase | Rationale |
|------|---------|-----|-------|-----------|
| 1 | Per-Request EM Forking | 9.5 | 1 | **Security foundation.** Cross-tenant data leakage risk. Blocks safe implementation of everything else. |
| 2 | API Key Expiry & Rotation | 9.1 | 1 | **Security hygiene.** Baseline enterprise requirement. Small scope, high value. |
| 3 | Bridge Provider Entities to Proxy | 4.6 | 1 | **Architectural debt.** Current sync identity-map lookup is fragile. Unblocks multi-provider work. |
| 4 | Complete Multi-Provider Management | 4.7 | 1 | **Core feature completion.** Stories 3-7 are already defined. Users need self-service provider management. |
| 5 | Round-Trip Lifecycle Smoke Test | 1.7 | 1 | **Quality gate.** Validates the full pipeline. Must exist before adding complexity. |
| 6 | UX Consistency Fixes | -- | 1 | **Polish.** #109 tracks toggles, buttons, modals. First impression matters for beta users. |
| 7 | Anthropic Claude Adapter | 4.1 | 2 | **Provider breadth.** Claude is the #2 LLM provider. Immediate demand from users. |
| 8 | Google Gemini / Vertex AI Adapter | 4.2 | 2 | **Provider breadth.** Completes the top-3 provider coverage. |
| 9 | Granular RBAC | 8.2 | 2 | **Enterprise gate.** No enterprise will adopt without role-based access control. |
| 10 | Audit Logging | 2.1 | 2 | **Compliance gate.** Required for SOC 2 and enterprise procurement. Pairs with RBAC. |
| 11 | Trace Detail View | 6.8 | 2 | **Debugging essential.** Users need to see what was sent/received. Small effort, huge value. |
| 12 | Agent Versioning & Rollback | 1.2 | 2 | **Safety net.** Enables confident iteration. Foundation for A/B testing and canary. |
| 13 | Usage Quotas & Rate Limiting | 2.5 | 2 | **Cost control.** Prevents runaway spend. Required before billing integration. |
| 14 | Cost Dashboard | 6.3 | 2 | **Visibility.** Users need to see what they are spending. Builds on existing cost estimation. |
| 15 | Incremental KB Updates | 3.7 | 2 | **RAG usability.** Full re-weave for one document change is painful. High-frequency request. |
| 16 | Agent Playground | 7.3 | 2 | **DX.** Interactive testing without CLI. Drives portal engagement. |
| 17 | Spec Versioning (v0 -> v1) | 10.1 | 2 | **Stability contract.** Must graduate before public launch. |
| 18 | Agent Evaluation Framework | 1.1 | 3 | **Quality.** Foundation for marketplace, canary, and A/B. Biggest Phase 3 enabler. |
| 19 | Model Routing & Fallback | 4.3 | 3 | **Resilience.** Production systems need automatic failover. |
| 20 | Hybrid Search (BM25 + Vector) | 3.3 | 3 | **RAG quality.** Significant retrieval improvement for keyword-heavy queries. |

### Sequencing Rationale

**Ranks 1-6 (Phase 1 -- Beta Hardening):** Fix the security foundation (EM forking, key rotation), complete the in-progress provider work, and polish the UX. These are bugs and debt, not features. They must be resolved before inviting more beta users.

**Ranks 7-17 (Phase 2 -- Production Readiness):** Add the provider adapters that users are asking for, implement the enterprise basics (RBAC, audit logs, quotas), and deliver the debugging/visibility tools that make Arachne usable in production. This phase ends with spec v1 graduation.

**Ranks 18-20 (Phase 3 -- Differentiation):** With a solid production platform, build the features that differentiate Arachne from raw API access: evaluations, intelligent routing, and advanced RAG. These create compounding value -- evals enable marketplace, routing enables cost optimization, hybrid search enables enterprise RAG.

---

## Part 4: Feature Interaction Map

Features do not exist in isolation. This map shows how capabilities enable, enhance, or depend on each other.

```
                    +-----------------+
                    | Per-Request EM  |
                    | Forking (9.5)   |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+         +---------v---------+
    | Bridge Provider   |         | Multi-Provider    |
    | Entities (4.6)    +-------->| Management (4.7)  |
    +---------+---------+         +---------+---------+
              |                             |
    +---------v---------+         +---------v---------+
    | Claude (4.1)      |         | Gemini (4.2)      |
    | Bedrock (4.8)     |         |                   |
    +---------+---------+         +---------+---------+
              |                             |
              +--------------+--------------+
                             |
                   +---------v---------+
                   | Model Routing &   |
                   | Fallback (4.3)    |
                   +---------+---------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+         +---------v---------+
    | Cost-Optimized    |         | Provider Health   |
    | Routing (4.4)     |         | Monitoring (4.9)  |
    +-------------------+         +-------------------+
              |
    +---------v---------+
    | Billing &         |
    | Metering (8.4)    |
    +-------------------+
```

```
    +-------------------+         +-------------------+
    | Agent Versioning  |         | Eval Framework    |
    | & Rollback (1.2)  |         | (1.1)             |
    +---------+---------+         +---------+---------+
              |                             |
              +--------------+--------------+
              |              |              |
    +---------v---+   +------v------+  +----v-----------+
    | A/B Testing |   | Canary      |  | RAG Eval       |
    | (1.3)       |   | Deploy (1.4)|  | Metrics (3.6)  |
    +------+------+   +------+------+  +----------------+
           |                 |
           +--------+--------+
                    |
          +---------v---------+
          | Agent Marketplace |
          | (1.5)             |
          +-------------------+
```

```
    +-------------------+         +-------------------+
    | Audit Logging     |         | Granular RBAC     |
    | (2.1)             |         | (8.2)             |
    +---------+---------+         +---------+---------+
              |                             |
              +--------------+--------------+
              |              |              |
    +---------v---+   +------v------+  +----v-----------+
    | Retention   |   | SSO         |  | Organization   |
    | Policies(2.2)|  | (8.1)       |  | Mgmt (8.3)     |
    +------+------+   +-------------+  +----+-----------+
           |                                |
           |                      +---------v---------+
           |                      | Billing &         |
           |                      | Metering (8.4)    |
           +---->  Data           +-------------------+
                   Residency (2.6)
```

```
    +-------------------+         +-------------------+
    | Chunking          |         | System Embedder   |
    | Strategies (3.2)  |         | (exists)          |
    +---------+---------+         +---------+---------+
              |                             |
              +--------------+--------------+
                             |
                   +---------v---------+
                   | Hybrid Search     |
                   | (3.3)             |
                   +---------+---------+
                             |
                   +---------v---------+
                   | Reranking (3.4)   |
                   +---------+---------+
                             |
                   +---------v---------+
                   | Multi-Modal       |
                   | RAG (3.5)         |
                   +-------------------+
```

```
    +-------------------+
    | Analytics (exists)|
    +---------+---------+
              |
    +---------v---------+         +-------------------+
    | Cost Dashboard    |         | Custom Metrics    |
    | (6.3)             |         | (6.1)             |
    +---------+---------+         +---------+---------+
              |                             |
              +--------------+--------------+
                             |
                   +---------v---------+
                   | Threshold         |
                   | Alerting (6.2)    |
                   +---------+---------+
                             |
                   +---------v---------+
                   | SLO Tracking      |
                   | (6.4)             |
                   +-------------------+
```

### Key Interaction Chains

1. **Security Chain:** Per-request EM forking (9.5) -> Provider bridge (4.6) -> Multi-provider management (4.7) -> All downstream provider features
2. **Enterprise Chain:** RBAC (8.2) -> Audit logging (2.1) -> SSO (8.1) -> Organization management (8.3) -> Billing (8.4)
3. **Agent Quality Chain:** Agent versioning (1.2) -> Eval framework (1.1) -> A/B testing (1.3) -> Canary deployments (1.4) -> Marketplace (1.5)
4. **RAG Quality Chain:** Chunking strategies (3.2) -> Hybrid search (3.3) -> Reranking (3.4) -> RAG eval metrics (3.6)
5. **Cost Chain:** Cost dashboard (6.3) -> Usage quotas (2.5) -> Cost-optimized routing (4.4) -> Billing (8.4)
6. **Observability Chain:** Trace detail view (6.8) -> Custom metrics (6.1) -> Alerting (6.2) -> SLO tracking (6.4)

### Cross-Category Synergies

| Feature A | Feature B | Synergy |
|-----------|-----------|---------|
| Eval framework (1.1) | RAG eval metrics (3.6) | Evals provide the scoring infrastructure; RAG evals define domain-specific metrics |
| Cost dashboard (6.3) | Cost-optimized routing (4.4) | Visibility drives optimization -- you optimize what you measure |
| RBAC (8.2) | Audit logging (2.1) | Role changes must be audited; audit log access must be role-gated |
| Agent playground (7.3) | Trace detail view (6.8) | Playground should show trace details for each test interaction |
| Marketplace (1.5) | Eval framework (1.1) | Quality signals from evals provide trust indicators for marketplace listings |
| PII detection (2.3) | Content filtering (2.4) | Shared scanning infrastructure; PII is a special case of content filtering |
| SDKs (7.1) | OpenAPI spec (7.4) | OpenAPI spec drives SDK auto-generation; SDKs validate the spec |
| Provider health (4.9) | Model routing (4.3) | Health status feeds routing decisions; unhealthy providers get deprioritized |

---

## Blog Entry

### The Road Ahead for Arachne: From Beta to Production AI Runtime

When we started building Arachne, we had a simple thesis: teams building with LLMs need infrastructure that is provider-agnostic, observable, and secure by default. Six months later, the core gateway is live, the artifact registry works end-to-end, and early beta tenants are running agents with conversation memory and RAG retrieval in production.

But a beta is not a product. Today we are publishing our full feature roadmap -- 60+ features across 10 categories, with clear priorities and a sequenced implementation order. Here is what matters most and why.

**Phase 1 is about foundations, not features.** Our top priorities are not glamorous: fixing per-request EntityManager forking to guarantee tenant isolation, completing API key rotation, and bridging the provider entity system to the proxy layer. These are the kinds of things that no one tweets about, but that determine whether Arachne is trustworthy infrastructure or a prototype. We are also finishing the multi-provider management stories (3 through 7) so tenants can bring their own provider keys without admin intervention.

**Phase 2 is provider breadth and enterprise readiness.** The most common request from beta users is "can I use Claude?" -- closely followed by "can I use Gemini?" We will ship native Anthropic and Google adapters in Phase 2, giving Arachne coverage across the top three LLM providers. Alongside that, we are building the enterprise basics: granular RBAC with owner/admin/member/viewer roles, audit logging for all administrative actions, and usage quotas to prevent runaway costs. We are also graduating the spec from v0 to v1 with formal JSON Schema validation and backward compatibility guarantees.

**Phase 3 is where Arachne becomes more than a proxy.** The agent evaluation framework (`arachne eval`) will let teams run automated test suites against their agents with scored assertions -- exact match, LLM-as-judge, semantic similarity. Combined with agent versioning and A/B testing, this creates a proper CI/CD pipeline for AI agents, something that barely exists in the ecosystem today. On the RAG side, hybrid search (BM25 + vector) and cross-encoder reranking will push retrieval quality well beyond what a naive vector search delivers. And intelligent model routing with automatic provider fallback will make Arachne the resilient production layer that teams need when they are serving real users.

**Phase 4 is ecosystem.** A plugin system for custom providers and guardrails. An agent marketplace where teams can share and discover proven agents. SSO integration for enterprise identity providers. And open spec governance so the Arachne agent format belongs to the community, not just to us.

One thing we have learned from the beta: the features that matter most are not the ones that demo well. Encryption key rotation is not exciting, but it is required. Trace detail views are not innovative, but developers ask for them daily. IP allowlisting is not a differentiator, but it is on every enterprise procurement checklist. We are building the mundane things first because reliable infrastructure is the foundation for everything else.

The full roadmap is available in our repository at `docs/feature-roadmap.md`. If you are interested in contributing or have opinions on priority, open an issue or join the discussion. We are building Arachne in the open because we believe AI infrastructure should be transparent, portable, and community-driven.
