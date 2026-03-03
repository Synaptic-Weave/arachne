# Team Decisions

## 2026-03-03: Beta Signup Proxy Fix — nginx Host Header & Infrastructure

**By:** Fenster (Backend), Hockney (Tester), Kujan (DevOps)  
**PR:** #97  
**Branch:** `feature/fix-beta-signup-proxy`

### nginx proxy Host Header Must Match Upstream FQDN for Azure Container Apps
**Decision:** Hardcode gateway FQDN in `proxy_set_header Host` directive; enable SNI with `proxy_ssl_server_name on`.  
**Rationale:** ACA routes traffic by Host header. `proxy_set_header Host $host` forwards the client's host (portal domain `arachne-ai.com`) to the gateway, causing ACA to reject the request. Fixed by:
- `proxy_set_header Host ca-arachne-gateway-prod.happysea-1e8f1a10.centralus.azurecontainerapps.io;`
- `proxy_ssl_server_name on;` for SNI support
**Impact:** Beta signup form POST now routes correctly to the gateway; silent failures eliminated.

### Beta Signup Coverage Gap — Email Validation Whitespace Ordering
**Reporter:** Hockney (Tester)  
**Severity:** Low (UX issue, not security/data integrity)  
**Issue:** Email validation regex runs BEFORE trimming, rejecting valid emails with leading/trailing whitespace.
- Input `"  user@example.com  "` → 400 error (regex rejects)
- Input `"user@example.com"` → 201 success (trimmed later)

**Recommendation:** Trim email BEFORE validation (1-line change in `src/routes/beta.ts`):
```typescript
const trimmedEmail = email.toLowerCase().trim();
if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
  return reply.code(400).send({ error: 'Valid email is required' });
}
```
**Test Coverage:** Hockney wrote 10 tests for POST /v1/beta/signup; test for whitespace will need updating if validation order is fixed.

### Local Dev Postgres Image Must Be pgvector/pgvector:pg16
**Decision:** Use `pgvector/pgvector:pg16` instead of `postgres:16-alpine` in `docker-compose.yml`.  
**Rationale:** pgvector extension required for migration 015 (kb_chunks embeddings table). Alpine image does not include pgvector; migrations fail locally without it.
**Impact:** Developers can now run full migration suite locally without manual pgvector extension installation.

## 2026-03-02: CI and GHCR Publish Workflows

**By:** Kujan (DevOps)  
**Issues:** #85, #86  

### CI Workflow (`.github/workflows/ci.yml`)
- Triggers on PR to `main` and `dev`
- Two parallel jobs: `test` and `lint`
- `test` installs root + `cli/` deps, runs `vitest run`, builds root and cli
- `lint` installs root deps, runs `npm run lint --if-present` (graceful no-op if script absent)
- Uses `actions/checkout@v4`, `actions/setup-node@v4` with npm cache, Node 20

### Publish Workflow (`.github/workflows/publish.yml`)
- Triggers on push to `main` only (not dev — images only from stable branch)
- Single `publish` job with `packages: write` permission for GHCR auth
- Builds and pushes two images: `arachne-gateway` and `arachne-portal`
- Tags: `:latest` and `:<full-sha>` for traceability
- Package visibility must be set to public manually in GitHub Settings → Packages after first push

### Key Decisions
- **No build matrix** — single Node 20 target; matrix can be added later if needed
- **GITHUB_TOKEN for GHCR** — no external secrets required; token has `packages: write` via job permission
- **SHA tag** — full commit SHA used (not short) for precision; matches GitHub's `github.sha` context
- **Portal image** — uses `context: .` (repo root) because Dockerfile.portal likely references portal/ subdirectory

## 2026-03-02: Terraform Azure Infra + Deploy Workflow

**By:** Kujan (DevOps)  
**Issues:** #87, #88  

### Key Decisions
- **`workflow_run` trigger:** Deploy waits for publish workflow completion to ensure GHCR images exist (avoids race conditions)
- **Secrets as Terraform variables (v1):** DATABASE_URL, MASTER_KEY, JWT_SECRET, ADMIN_JWT_SECRET passed as sensitive `TF_VAR_*` env vars; Key Vault deferred to v2
- **Database NOT in Terraform (v1):** PostgreSQL provisioned manually to prevent accidental `terraform destroy` wiping production data; will import in v2
- **Image override variables:** `gateway_image` and `portal_image` default to empty string; fall back to `:latest` when empty (allows local `terraform plan/apply` without real SHA)
- **SIGNUPS_ENABLED=false hardcoded:** Static env var, visible in plan, clearly documents invite-only beta decision
- **Resource asymmetry:** Gateway (0.5 CPU / 1 GiB) for AI proxy compute; Portal (0.25 CPU / 0.5 GiB) for static React bundle

## 2026-03-02: Beta Launch Backend — Signups & CORS

**By:** Fenster (Backend)  
**Issues:** #75, #79, #84  

### SIGNUPS_ENABLED Semantics
**Decision:** Treat any value other than `"false"` as signups-enabled (not `=== "true"` check).  
**Rationale:** Safer default — if the env var is accidentally unset or misspelled, signups remain open rather than silently locking out users.

### Config Module
**Decision:** Created dedicated `src/config.ts` module for app-wide config helpers rather than inlining checks.  
**Rationale:** Single source of truth; reusable across modules (e.g., future admin overrides); consistent with team preference for explicit module boundaries.

### HTTP Status for Disabled Signups
**Decision:** Return HTTP 503 (Service Unavailable) when signups are disabled, not 401 (Unauthorized).  
**Rationale:** 401 implies authentication failure; 503 correctly signals the service is intentionally unavailable. Portal UI can display waitlist CTA on 503.

### Beta Signups — No Auth
**Decision:** `POST /v1/beta/signup` is a fully public endpoint with no authentication.  
**Rationale:** Pre-signup users have no credentials; rate limiting can be added later at the nginx/load-balancer layer if needed.

### Duplicate Email Response
**Decision:** Return HTTP 200 `{ status: "already_registered" }` for duplicate beta signups rather than 409.  
**Rationale:** From the user's perspective, their email is already on the list — this is a successful outcome. 409 would surface as an error in the UI unnecessarily.

### CORS Already Implemented
**Decision:** No code change needed for #84; `src/index.ts` already had the correct ALLOWED_ORIGINS parsing.  
**Rationale:** Verified existing code correctly splits comma-separated origins and falls back to `true` (permissive) when unset. Only .env.example documentation was missing.

## 2026-03-02: Beta Launch Frontend Sprint

**By:** McManus (Frontend Dev)  
**Issues:** #71, #72, #74, #76, #77, #78, #80, #81, #82, #83  

### Beta Signup Form — Direct Fetch
**Decision:** Beta signup form uses direct `fetch`, not the `api` module.  
**Rationale:** `/v1/beta/signup` is unauthenticated and doesn't fit the existing `api.ts` request helper pattern (no token, different error shape). Inline fetch directly in `LandingPage.tsx` using `import.meta.env.VITE_API_BASE_URL` as base.

### VITE_API_BASE_URL Already Wired
**Decision:** No migration needed; `portal/src/lib/api.ts` already declared `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''`.  
**Rationale:** No hardcoded gateway URLs existed in portal source. Only change was creating `portal/.env.example` to document the variable.

### CLI Default URL Already Set
**Decision:** Closed #72 without code changes; `cli/src/config.ts` already defaulted to `https://api.arachne-ai.com`.  
**Rationale:** Feature already shipped; docs only update needed.

### CLI Init Config Fullness
**Decision:** `arachne init` saves full config (gatewayUrl + token), not just one field.  
**Rationale:** Consistent with `login.ts` which also calls `writeConfig({ gatewayUrl, token })`. Existing config read first so defaults are pre-filled.

### Footer Placement
**Decision:** Footer is on public pages only (LandingPage, PrivacyPage, AboutPage), not AppLayout.  
**Rationale:** AppLayout sidebar footer is a "sign out" button for authenticated users. Public-facing Synaptic Weave copyright/links footer lives as inline footers on relevant pages. Kept minimal—no separate Footer component created.

# Team Decisions
## 2026-02-27: Subtenant Hierarchy with Self-Foreign Key

**By:** Fenster (Backend)  
**What:** Added `parent_id` column to `tenants` table (nullable self-FK) with ON DELETE CASCADE  
**Why:** Product requires subtenant hierarchy; single-parent tree avoids complexity of multi-parent graphs  
**Impact:** Tenants can form a parent-child hierarchy; deleting a parent cascades to all subtenants; portal operators manage parent tenant + all descendants  
**Alternatives Considered:** Separate join table (rejected: overkill for linear hierarchy)  

## 2026-02-27: Agent System Architecture

**By:** Fenster (Backend)  
**What:** Implemented agents table with per-agent `provider_config`, `system_prompt`, `skills`, `mcp_endpoints`, and `merge_policies` (JSONB). Every API key bound to exactly one agent (NOT NULL FK). Every trace records which agent processed it (nullable for historical rows).  
**Why:** Product requires configurable agents with isolated provider configs; API keys must be agent-scoped; audit requires recording which agent handled each request  
**Impact:** Agents enable multi-agent workflows; per-agent provider configs; API key access control scoped to agents, not just tenants; traces linked to agents for analytics  
**Decisions:**
- `agents.merge_policies` is NOT NULL with application-level default (avoids null-checks in gateway)
- Seeded "Default" agent for every existing tenant before enforcing `api_keys.agent_id NOT NULL`
- `traces.agent_id` is nullable (preserves historical data integrity)
- Down migration reverses in strict FK dependency order

## 2026-02-27: Agent Provider Config Encryption

**By:** Fenster (Backend)  
**What:** Agent `provider_config` JSONB field encrypted on write (AES-256-GCM) and sanitized on read (returns `hasApiKey: boolean` instead of raw key)  
**Why:** API keys inside agent config must be protected; consistency with existing tenant settings pattern  
**Impact:** Zero new encryption logic; same encrypt-on-write / sanitize-on-read as tenant settings; sensitive data never exposed in API responses  

## 2026-02-27: Portal Agent Routes — Membership-Based Access Control

**By:** Fenster (Backend)  
**What:** Agent GET/PUT/DELETE endpoints verify access via `JOIN tenant_memberships` on agent's tenant, not tenantId equality  
**Why:** Users can be members of multiple tenants; should access agents from any tenant they're a member of  
**Impact:** More permissive and flexible for multi-tenant users; agent access tied to tenant membership, not JWT tenant context  

## 2026-02-27: Portal Agent Routes — Dynamic SET Builder for Partial Updates

**By:** Fenster (Backend)  
**What:** PUT /v1/portal/agents/:id uses dynamic SET clause builder; only supplied fields updated (plus always-updated `updated_at`)  
**Why:** Support partial updates without coalescing (which would silently drop null inputs); avoids read-then-write  
**Impact:** Clean parameterized SQL, no injection risk, explicit control over which fields are updated  

## 2026-02-27: Agent Config Inheritance — JavaScript Layer

**By:** Fenster (Backend)  
**What:** Resolved agent config computed in TypeScript (not SQL). Build ordered array [agent, immediate_tenant, parent_chain...]. Use `.find(non-null)` for providerConfig/systemPrompt, union+dedup for skills/mcpEndpoints, agent-only for mergePolicies.  
**Why:** Mixed inheritance semantics (first-non-null vs. union) cleaner in application code than monolithic SQL; tenant chain typically shallow (depth 1-5); keeps queries simple and testable  
**Impact:** Readable inheritance logic; easy to test and debug; no complex CASE/COALESCE chains  

## 2026-02-27: Subtenant Creation with Transaction

**By:** Fenster (Backend)  
**What:** POST /v1/portal/subtenants wraps tenant INSERT + membership INSERT in explicit BEGIN/COMMIT/ROLLBACK transaction  
**Why:** Prevent orphaned tenant if membership insert fails  
**Impact:** Atomic subtenant creation; consistent with existing signup transaction pattern  

## 2026-02-27: Analytics Rollup with Recursive CTE

**By:** Fenster (Backend)  
**What:** Added optional `rollup?: boolean` parameter to three analytics functions (`getAnalyticsSummary`, `getTimeseriesMetrics`, `getModelBreakdown`). When true, prepend `WITH RECURSIVE subtenant_tree` CTE to walk `tenants.parent_id` and aggregate traces across all descendants.  
**Why:** Portal operators managing a parent tenant need aggregate analytics across all subtenants; backward compatible (rollup defaults to false)  
**Impact:** Parent tenant dashboard shows rolled-up metrics; partition pruning preserved (CTE restricted to tenants table); no impact on existing callers  
**Alternatives Considered:** Materialised view of tenant trees (rejected: overkill, stale-data issues); JOIN on tenants at query time (rejected: complex, potential index miss)  

## 2026-02-27: Gateway Agent-Aware Lookup — Two-Query Pattern

**By:** Fenster (Backend)  
**What:** Split agent config resolution into two queries: (1) api_keys → agents → immediate tenant (one JOIN), (2) separate recursive CTE for parent chain if parent_id non-null  
**Why:** Simpler than monolithic CTE; parent chain query skipped entirely for common case (no parent); keeps each query readable and independently testable  
**Impact:** Clean separation of concerns; better performance on non-parent tenants  

## 2026-02-27: Provider Cache Keyed by Agent ID

**By:** Fenster (Backend)  
**What:** `providerCache` keyed by `agentId` (fallback to `tenantId`). Added `tenantIndex: Map<tenantId, Set<cacheKey>>` to allow `evictProvider(tenantId)` to clear all agent-level providers for a tenant without changing the public API.  
**Why:** Agents can have their own provider configs; need per-agent caching. Reverse index allows admin routes to continue using existing `evictProvider(tenantId)` signature.  
**Impact:** Correct per-agent provider instances; existing admin callers unaffected; zero API changes  

## 2026-02-27: MCP Tool Routing on Non-Streaming Only

**By:** Fenster (Backend)  
**What:** `handleMcpRoundTrip()` called only on non-streaming (JSON) responses. Streaming responses not eligible for MCP routing in Phase 1.  
**Why:** Streaming + tool_calls requires buffering full SSE stream before routing to MCP and re-streaming follow-up. Significant complexity and latency. Common agentic pattern (tool use) typically non-streaming.  
**Impact:** Tool calling works on JSON responses; streaming MCP support deferred to Phase 2  

## 2026-02-27: Agent Merge Policies Applied at Request-Time

**By:** Fenster (Backend)  
**What:** `applyAgentToRequest()` in `src/agent.ts` applies merge policies to outbound request body before provider. Original `request.body` not mutated.  
**Why:** Keeps providers clean (see plain OpenAI-format requests); immutability avoids side effects  
**Impact:** Providers receive consistent OpenAI format; no surprises for middleware or test code reading request.body  

## 2026-02-27: SubtenantsPage Navigation Gated by Owner Role

**By:** McManus (Frontend)  
**What:** Subtenants nav link only visible to `currentRole === 'owner'`. Agents nav visible to all authenticated users.  
**Why:** Creating subtenants is administrative; agents are tenant-scoped configs that all members may need. Mirrors API Keys visibility (all roles).  
**Impact:** Role-based nav structure; members see Agents but not Subtenants; owners see both  

## 2026-02-27: AgentEditor as Inline Panel (Not Modal)

**By:** McManus (Frontend)  
**What:** AgentEditor renders as inline panel on AgentsPage (above table) with discriminated union state: `{ mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; agent: Agent }`  
**Why:** Simpler state management; keeps agents list visible for context; matches existing MembersPage pattern; no animation primitives needed  
**Impact:** Cleaner UX; full agents list visible while editing; type-safe editor state  

## 2026-02-27: Agent Resolved Config Lazy-Loaded

**By:** McManus (Frontend)  
**What:** `getResolvedAgentConfig` API call only made when user expands "View inherited config"; cached in component state for session  
**Why:** Avoid extra API call on every editor open; resolved config is informational/debugging, not required for saving  
**Impact:** Fewer API calls; better perceived performance on page load  

## 2026-02-27: API Types Consolidated in api.ts

**By:** McManus (Frontend)  
**What:** All new interfaces (`Subtenant`, `Agent`, `AgentConfig`, `ResolvedAgentConfig`, etc.) added to bottom of `portal/src/lib/api.ts` (not separate file)  
**Why:** Single source of truth for API contracts; consistent with existing pattern  
**Impact:** Easier to maintain API contracts; import from one file  

## 2026-02-27: API Keys Agent Selector Required

**By:** McManus (Frontend)  
**What:** ApiKeysPage now requires agent selection in create form. If no agents exist, create button disabled with message "Create an agent first before generating API keys". API call updated: `{ name: string; agentId: string }`.  
**Why:** Product enforces agent_id NOT NULL; every API key must be bound to an agent  
**Impact:** Users cannot create API keys without an agent; clear error messaging  

## 2026-02-27: Analytics Rollup Scope Selector

**By:** McManus (Frontend)  
**What:** AnalyticsPage new "Scope" dropdown: "All — roll up subtenants + agents" (default, `rollup=true`) vs. "This org only" (no param). All three fetch functions append `?rollup=true` when selected. Component remounted (via `key` change) on scope toggle.  
**Why:** Parent tenant operators need to see rolled-up metrics; scope toggle is a natural UX pattern  
**Impact:** Analytics correctly reflects scope; component remount ensures clean fetch on scope change  

## 2026-02-27: Settings Page Renamed to Org Defaults

**By:** McManus (Frontend)  
**What:** SettingsPage title: "Provider settings" → "Org Defaults". Subtitle clarifies defaults are inherited by agents. Note added: "These settings are inherited by all agents in this org unless the agent defines its own."  
**Why:** Clarify relationship between org-level defaults and agent-level overrides  
**Impact:** User understanding of inheritance model improved  

## 2026-02-26T16:52:15Z: User directive — Commit After Every Major Update

**By:** Michael Brown (via Copilot)  
**What:** Commit and push after every major update going forward  
**Why:** User request — establish commit-after-every-major-update practice for team continuity  
**Impact:** Coordinator will commit/push after every agent batch; session logs capture decision context; team maintains living decision history

## 2026-02-24T02:33:16.822Z: Tech Stack

**By:** Michael Brown  
**What:** Node.js + TypeScript for Loom implementation  
**Why:** User decision during team setup  
**Impact:** All code will be TypeScript-first

## 2026-02-24T02:33:16.822Z: Phase 1 Scope

**By:** Michael Brown (via PRD)  
**What:** Phase 1 focuses on Gateway (Auditability Foundation) — OpenAI-compatible proxy, streaming support, structured trace recording, token/cost/latency tracking, multi-tenant architecture, minimal observability dashboard  
**Why:** PRD defines phased rollout; Phase 1 establishes audit foundation before governance layer  
**Impact:** Team will defer A/B testing, policy enforcement, memory abstraction, agent orchestration, PII detection, and budget controls to Phase 2+

## 2026-02-24T02:33:16.822Z: Architecture Discussion Required

**By:** Michael Brown  
**What:** Hold architecture conversation before building  
**Why:** User requested architecture discussion before implementation  
**Impact:** Keaton will facilitate design meeting to align on gateway architecture, trace schema, and multi-tenant design before Fenster/McManus start building

## 2026-02-24T02:47:45Z: Architecture Constraints

**By:** Michael Brown (via Copilot)  
**What:** Multi-provider Phase 1 (Azure OpenAI + OpenAI), full body storage enabled, single process topology, 1000 req/sec capacity target  
**Why:** User decisions during architecture discussion — Azure for free testing tokens, auditability requires full bodies, pragmatic Phase 1 scope  
**Impact:** Provider abstraction supports both OpenAI and Azure OpenAI; trace schema stores complete request/response bodies in JSONB; single Fastify process hosts gateway and dashboard; performance validation at 1000 req/sec

## 2026-02-24: Architecture Approved — Loom Phase 1 (Gateway/Auditability Foundation)

**By:** Keaton (Lead), approved by Michael Brown  
**What:** Complete architecture for Phase 1 including Fastify gateway, multi-provider support (OpenAI + Azure OpenAI), SSE streaming with transform stream tee, PostgreSQL with JSONB traces (partitioned by month), API key-based multi-tenant isolation, 3-6ms overhead target, REST dashboard API  
**Why:** Addresses all open questions, validated for 1000 req/sec, balances auditability needs with performance  
**Impact:** Defines work breakdown for Fenster (10 backend items), McManus (5 frontend items), Hockney (7 test items); establishes critical path through F1→F4→F6→F7→H6; locks architecture for Wave 1-4 execution

## 2026-02-24: Provider Abstraction Pattern

**By:** Fenster (Backend)  
**What:** Implemented provider abstraction using BaseProvider abstract class with shared authentication logic and provider-specific proxy implementations using undici HTTP client  
**Why:** Need consistent interface for multiple LLM providers (OpenAI, Azure OpenAI initially, more later)  
**Impact:** Easy to add new providers by extending BaseProvider; consistent error handling; stream and non-stream responses handled uniformly; provider configuration encapsulated

## 2026-02-24: Database Partitioning Strategy

**By:** Fenster (Backend)  
**What:** PostgreSQL native table partitioning for traces table by month on created_at column; 4 initial monthly partitions; indexes inherited automatically  
**Why:** Traces table will grow rapidly (1000 req/sec = ~2.6M req/day); need efficient querying and retention management  
**Impact:** Query performance via partition pruning; retention via dropping old month partitions; faster VACUUM/ANALYZE on smaller partitions; independent archival per month

## 2026-02-24: Database Tests Skip-by-Default Pattern

**By:** Hockney (Tester)  
**What:** Database tests skip by default, require explicit TEST_DB_ENABLED=1 environment variable to run  
**Why:** Improve developer experience — tests work immediately after npm install without PostgreSQL dependency  
**Impact:** Mock server tests (6 tests, 520ms) provide immediate validation; database fixture tests validate schema when PostgreSQL available; CI can enable selectively

## 2026-02-24: Test Framework — Vitest

**By:** Hockney (Tester)  
**What:** Selected Vitest over Jest for test infrastructure  
**Why:** Native ESM support aligns with project's "type": "module"; faster execution; better Node.js compatibility; Vite ecosystem consistency  
**Impact:** All future tests use Vitest; test command is npm test; Fenster and McManus should use Vitest for their test suites

## 2026-02-24: Dashboard Architecture — React + Vite SPA

**By:** McManus (Frontend)  
**What:** Implemented observability dashboard as React 19 + Vite SPA in dashboard/ subdirectory, served by Fastify at /dashboard via @fastify/static plugin  
**Why:** Fast development, modern tooling, TypeScript support; SPA architecture with client-side routing; keeps frontend code isolated  
**Impact:** Build output at dashboard/dist/ served statically; base path /dashboard/ configured; routes for Traces and Analytics; ready for REST API consumption in Wave 3

## 2026-02-24: Security Architecture — Tenant Data Encryption-at-Rest

**By:** Keaton (Lead), approved by Michael Brown  
**What:** Use encryption-at-rest for all tenant data in PostgreSQL (request_body and response_body columns). Application-level AES-256-GCM encryption with per-tenant key derivation. Dashboard analytics lag is acceptable for Phase 1 observability use case.  
**Why:** Protect against unauthorized database console access (insider threat, compromised admin credentials). Phase 1 threat model focuses on DB access boundary; full KMS migration deferred to Phase 2.  
**Impact:** Fenster adds encryption utility module and IV columns to traces migration; Hockney adds encrypted storage validation tests; schema includes encryption_key_version column for Phase 2 key rotation; key management strategy documented for GA compliance planning. Performance impact negligible (<0.01ms per trace encryption). No blockers identified.  
**Alternatives Considered:** PostgreSQL TDE (rejected: all-or-nothing, limited tenant isolation); no encryption + access controls (rejected: fails threat model); selective field encryption (rejected: complex PII detection logic).  
**Risk:** LOW. Standard encryption pattern, negligible performance impact, proven libraries.  
**Deferred to Phase 2:** External KMS integration, key rotation implementation, PII detection layer, ETL pipeline for real-time analytics.

## 2026-02-24: F3 — Tenant Auth Middleware: SHA-256 (not bcrypt)

**By:** Fenster (Backend)  
**What:** API key validation uses SHA-256 for hashing; LRU cache implemented with JavaScript Map (no external library); cache key = SHA-256 hash of raw API key; tenant provider_config nullable JSONB  
**Why:** bcrypt is intentionally slow (incompatible with 20ms overhead budget). SHA-256 sufficient for opaque random tokens; brute-force resistance from entropy. Map maintains insertion order for LRU eviction. Avoids storing raw keys in memory. Nullable config allows gradual rollout without backfill.  
**Impact:** Fast key validation in hot path; zero new dependencies; DB lookup and cache use same hash function; tenants without provider config can use global env defaults

## 2026-02-24: F5 — Azure OpenAI Adapter: api-key header strategy

**By:** Fenster (Backend)  
**What:** Azure authentication uses `api-key: <key>` header (not Authorization Bearer); error mapping at adapter boundary; only `x-request-id` forwarded as pass-through header  
**Why:** Azure OpenAI requires `api-key` per Microsoft docs; Bearer returns 401. Consistent error shape simplifies gateway. Forward only safe headers to avoid leaking internal metadata.  
**Impact:** Callers see unified error responses; Azure-specific quirks encapsulated; upstream header leakage prevented

## 2026-02-24: F6 — SSE Streaming Proxy: Transform stream design

**By:** Fenster (Backend)  
**What:** Push data before parse to minimize latency; onComplete in flush() not on [DONE] sentinel; Node.js Transform stream (not Web TransformStream)  
**Why:** Early push ensures client receives bytes immediately. flush() fires on upstream EOF regardless of [DONE] presence (robust to provider quirks). Node.js Transform avoids type adaptation overhead with undici Readable.  
**Impact:** Low-latency streaming; robust to provider edge cases; native Fastify integration

## 2026-02-24: H2 — Proxy Tests: Direct provider testing

**By:** Hockney (Tester)  
**What:** Test OpenAIProvider.proxy() directly instead of full gateway; gateway integration tests deferred until Fenster adds OPENAI_BASE_URL support  
**Why:** Fastify gateway cannot redirect to mock server without env var support from backend. Provider class IS the proxy mechanism.  
**Impact:** Proxy correctness validation complete (12 tests); gateway integration tests follow as F6+ follow-up

## 2026-02-24: H3 — Auth Tests: Inline reference implementation

**By:** Hockney (Tester)  
**What:** Implement reference Fastify gateway in tests/auth.test.ts mirroring expected auth contract; import swapped to src/auth.ts when Fenster ships  
**Why:** Contract well-understood (Bearer token, x-api-key, LRU, 401 on invalid). Tests document interface; immediate value; all assertions must pass once real module ships.  
**Impact:** Auth contract validated; 16 tests passing; zero flaky imports; seamless upgrade path to Fenster's F3

## 2026-02-24: H5 — Multi-Provider Streaming: Async iteration pattern

**By:** Hockney (Tester)  
**What:** All streaming test helpers use `for await...of` (async iteration protocol), not Web ReadableStream API  
**Why:** undici response.body is Node.js Readable; .getReader() fails on Node 25+. Async iteration works for Node Readable, Web ReadableStream, any async iterable.  
**Impact:** Canonical streaming test pattern for codebase; 33 multi-provider streaming tests passing; future proof

## 2026-02-24: Wave 2 Test Infrastructure — Port range 3011–3040

**By:** Hockney (Tester)  
**What:** Wave 2 test mock servers use ports 3011–3040 (existing mocks at 3001–3002); future waves continue upward (3041+)  
**Why:** Avoid port conflicts in parallel test runs  
**Impact:** 61 tests can run in parallel; scalable port allocation for future waves

## 2026-02-24: F7 — Trace Recording & Persistence

**By:** Fenster (Backend)  
**Issue:** #4  
**Decisions:**
1. **JSONB Column Storage** — Encrypted ciphertext (hex) stored as PostgreSQL JSONB scalar string via `to_jsonb($1::text)`. Avoids breaking ALTER TABLE while keeping schema consistent. Decryption: read JSONB string → JSON.parse → decrypt hex.
2. **IV Columns** — `request_iv varchar(24)` and `response_iv varchar(24)` added via migration 1000000000005. Nullable for backward compatibility; all new inserts populate both.
3. **Migration Numbering** — Used 1000000000005 (sequential after 1000000000004, which was taken by `add-tenant-provider-config.cjs`).
4. **Batch Flushing** — `this.batch.splice(0)` atomically drains batch before async DB writes. Any `record()` calls during flush land in fresh array, caught by next flush (prevents data loss).
5. **Timer Management** — 5-second setInterval is `unref()`'d to prevent test hangs (process can exit cleanly during vitest runs).
6. **Streaming Integration** — `traceContext` passed as optional field on `StreamProxyOptions` rather than re-architecting provider layer. `index.ts` populates when `request.tenant` available.

**Impact:** Encryption-at-rest foundation complete; streaming traces captured without provider awareness; batch atomicity prevents data loss.

## 2026-02-24: F8 — Analytics Engine Cost Calculation Strategy

**By:** Fenster (Backend)  
**Issue:** #5  
**Decision:** Inline SQL CASE expressions for cost estimation rather than application-layer model map.

**What:** Cost rates embedded as SQL CASE expressions using `ILIKE '%gpt-3.5%' OR ILIKE '%gpt-35%'` pattern matching, defaulting to GPT-4o rates for all other models.

**Why:** Single DB round trip computes all analytics in one query. No need to pull raw token rows into application memory. Supports new models automatically (falls back to GPT-4o rates). ILIKE covers both OpenAI (`gpt-3.5-turbo`) and Azure (`gpt-35-turbo`) model name variants.

**Rates (per token):**
- GPT-4o input: $0.000005, output: $0.000015
- GPT-3.5 input: $0.0000005, output: $0.0000015

**Impact:** All analytics queries complete in a single SQL call. Cost estimation available on any model without code changes; unknown models default to GPT-4o rates (conservative estimate).

## 2026-02-24: F9 — Dashboard API: Cursor Pagination

**By:** Fenster (Backend)  
**Issue:** #6  
**Decision:** Cursor pagination uses `created_at` ISO timestamp as the cursor value.

**What:** `GET /v1/traces?cursor={ISO_timestamp}` filters `created_at < cursor` ordered by `created_at DESC`. `nextCursor` is `null` when fewer than `limit` rows are returned.

**Why:** Offset pagination breaks under concurrent inserts (rows shift). Timestamp cursor is stable, human-readable, and maps directly to the existing `idx_traces_tenant_created` composite index. Limit capped at 200 rows per page to avoid unbounded queries.

**Impact:** Efficient paginated listing; no offset calculation; consistent results under write load.

## 2026-02-24: F9 — Dashboard Routes Registered via Plugin

**By:** Fenster (Backend)  
**Issue:** #6  
**Decision:** Dashboard routes registered via `fastify.register(registerDashboardRoutes)` — not inline in index.ts.

**Why:** Keeps index.ts focused on server bootstrap. Routes encapsulated in `src/routes/dashboard.ts` are independently testable. Auth middleware already applied globally via `addHook('preHandler')` — no extra auth wiring needed per route.

**Impact:** Clean separation of concerns; dashboard routes independently testable; global auth inheritance.

## 2026-02-24: F10 — Provider Registry: Per-Tenant Lazy Cache

**By:** Fenster (Backend)  
**Issue:** #7  
**Decision:** Module-level `Map<tenantId, BaseProvider>` for instance caching. No TTL; `evictProvider()` exposed for manual invalidation.

**What:** `getProviderForTenant(tenantCtx)` checks the module-level cache before constructing a new provider. Azure provider uses `tenantCtx.providerConfig.baseUrl` as the Azure endpoint and `deployment`/`apiVersion` from the same config.

**Why:** Provider construction is cheap but avoids object churn on every request. No TTL needed in Phase 1 — provider config changes are rare. `evictProvider()` provides an escape hatch when config changes without server restart.

**Impact:** Provider selection is O(1) on the hot path. Falls back to OpenAI + `OPENAI_API_KEY` env var when no `providerConfig` is set (backwards-compatible with existing deployments).

## 2026-02-24: Schema Addition: `status_code` column on `traces`

**By:** Fenster (Backend)  
**Issue:** #7  
**Decision:** Added `status_code smallint NULL` via migration `1000000000006`.

**Why:** F9 trace listing spec requires `status_code` in responses. `TraceInput` already carried an optional `statusCode` field but it was not persisted. Migration adds the column; `tracing.ts` INSERT updated to include it.

**Impact:** HTTP status codes tracked per trace; analytics dashboard can filter/display by response status; migration maintains backward compatibility (nullable column).

## 2026-02-24: H4 — Multi-Tenant Isolation Tests

**By:** Hockney (Tester)  
**Issue:** #14  
**Decisions:**
1. **fastify.inject() for Auth Tests** — Use Fastify's built-in `inject()` method for testing `registerAuthMiddleware` instead of binding to a real port. Avoids port allocation and bind-race conditions; tests are synchronous and isolated; no network stack overhead.
2. **Mocked pg.Pool** — Pass a `{ query: vi.fn() }` object as the `pg.Pool` argument to `registerAuthMiddleware`. No real PostgreSQL required; mock returns tenant fixtures keyed by SHA-256 hash of API key.
3. **Inactive Tenant Behavior (Deferred)** — Current behavior for deleted/inactive tenants is 401 (DB returns 0 rows, middleware has no 403 path). Future work: add `tenants.active` column, filter in query, return 403 for inactive tenants.

**Impact:** Auth and multi-tenant tests run in-process without any port conflicts; consistent with Wave 3 additions; test documents current behavior with TODO for Phase 2.

## 2026-02-24: H6 — Streaming + Trace Recording Tests

**By:** Hockney (Tester)  
**Issue:** #16  
**Decisions:**
1. **vi.mock + importOriginal Pattern** — Mock `src/tracing.js` using `importOriginal` — preserves the real `TraceRecorder` class while replacing the exported `traceRecorder` singleton with a spy object. SSE proxy tests need to spy on `traceRecorder.record()` (the singleton); batch/timer tests need the real class instantiated fresh per test.
2. **Single Mock for Dual Purpose** — Real class gets real encryption + real db.js mock for flush tests; single mock declaration serves all test suites.

**Impact:** Streaming integrity validated; batch flush timing confirmed; fire-and-forget trace recording during streaming verified; tests are maintainable and independent.

## 2026-02-24: H7 — Encryption-at-Rest Tests

**By:** Hockney (Tester)  
**Issue:** #17  
**Decisions:**
1. **INSERT Parameter Index Constants** — Document the positional SQL parameter indices (`IDX` object) at the top of `encryption-at-rest.test.ts`. TraceRecorder's INSERT uses 13 positional params; magic numbers in assertions are unmaintainable. If Fenster reorders INSERT params, tests fail loudly at the index documentation layer, not silently.

**Impact:** Per-tenant key derivation validated; unique IVs per trace confirmed; AES-256-GCM success and failure modes thoroughly tested.

## 2026-02-24: H4/H6/H7 — Wave 3 Test Infrastructure Port Allocation

**By:** Hockney (Tester)  
**Issues:** #14, #16, #17  
**Decision:** Wave 3 tests (H4, H6, H7) use `fastify.inject()` exclusively — no ports allocated.

**Why:** All three test suites test in-process behavior; no mock HTTP servers needed.

**Impact:** No port conflicts; Wave 3 port range (3041+) remains available for future integration test suites; 85 tests passing with 100% pass rate.

## 2026-02-24: M2 — Traces Table: Infinite Scroll & Client-Side Filtering

**By:** McManus (Frontend)  
**Issue:** #8  
**Decisions:**
1. **IntersectionObserver Pagination** — Infinite scroll uses an `IntersectionObserver` on a sentinel `<div>` below the table with `rootMargin: 200px`. When the sentinel enters the viewport, the next page is fetched using `nextCursor` from the last API response.
2. **Client-Side Filtering** — Model and status filters in TracesTable operate on the client-side set of loaded traces (up to 50 per page). The `/v1/traces` API does not expose filter query params. Acceptable for Phase 1 volume — revisit if server-side filtering is needed at scale.

**Impact:** Seamless infinite scroll UX; client-side filters enable rapid iteration; deferred server-side filtering to Phase 2 when volume demands optimization.

## 2026-02-24: M3 — Trace Details: Encrypted Body Placeholder

**By:** McManus (Frontend)  
**Issue:** #9  
**Decision:** Request and response bodies are displayed as "🔒 Encrypted (stored securely)" per the security architecture decision (AES-256-GCM encryption at rest). Bodies are not returned by the dashboard API.

**Why:** Aligns with encryption-at-rest design; prevents accidental plaintext leakage through dashboard; phase 1 focuses on auditability metadata (tokens, latency, cost) rather than request/response inspection.

**Impact:** Users see explicit security indicator; no accidental exposure of encrypted data through UI; database remains the trust boundary.

## 2026-02-24: M4 — Analytics Summary: Time Window State Management

**By:** McManus (Frontend)  
**Issue:** #10  
**Decision:** The time window selector (1h/6h/24h/7d) lives in `AnalyticsPage` and is passed as a prop to both `AnalyticsSummary` and `TimeseriesCharts`. This keeps both components in sync without extra state management overhead.

**Impact:** Single source of truth for time window; both summary cards and charts reflect selected window; no state synchronization bugs.

## 2026-02-24: M5 — Timeseries Charts: recharts AreaChart with Auto-Bucketing

**By:** McManus (Frontend)  
**Issue:** #11  
**Decisions:**
1. **recharts AreaChart** — Used `recharts` (added to `dashboard/package.json`) with `AreaChart` + `ResponsiveContainer` for both charts. Responsive by default.
2. **Time-Aware Bucketing** — Bucket size derived from selected time window: 1h→5min, 6h→30min, 24h→60min, 7d→360min. Ensures chart readability across all time scales.

**Impact:** Production-ready timeseries visualization; responsive design works on all devices; automatic bucketing prevents over-plotting at different scales.

## 2026-02-24: M2–M5 — Frontend API Integration: localStorage API Key

**By:** McManus (Frontend)  
**Issues:** #8–#11  
**Decision:** API key stored in `localStorage` under key `loom_api_key`. Prompted via modal overlay on first visit (or if key is missing). Simple and sufficient for Phase 1; no server-side session needed.

**Why:** Eliminates multi-step auth flow; API key naturally scoped to browser origin; localStorage persists across sessions without server state.

**Impact:** Users provide API key once per device/browser; dashboard automatically includes key in Authorization header for all API requests; no session backend required for Phase 1.

## 2026-02-24: M3 — Trace Details: Estimated Cost Calculation (Rough)

**By:** McManus (Frontend)  
**Issue:** #9  
**Decision:** TraceDetails shows estimated cost using: `(promptTokens * 0.01 + completionTokens * 0.03) / 1000`. This is GPT-4-class pricing approximation. The actual cost is not returned by `/v1/traces`. Should be replaced with real cost data when the API adds it.

**Why:** Provides visibility into cost implications during Phase 1; approximation acceptable when actual costs not available.

**Impact:** Users see cost estimates in trace details; Phase 2 API enhancement will replace with real cost from backend analytics engine.

## 2026-02-25: F — Instrumentation: TTFB + Gateway Overhead Metrics

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Status:** Implemented

**What:** Wired `ttfb_ms` and `gateway_overhead_ms` columns (pre-existing in DB schema) into the full request lifecycle — from capture through trace recording to dashboard API response.

**Metrics Defined:**
- `ttfb_ms` — Elapsed ms from gateway start to first SSE byte (for non-streaming: equals latency_ms)
- `gateway_overhead_ms` — Pre-LLM gateway work time (auth, routing, parsing, provider selection)

**Changes Made:**
- `src/tracing.ts` — Added `ttfbMs` and `gatewayOverheadMs` to `TraceInput` and `BatchRow` interfaces; updated INSERT to 16 positional params
- `src/streaming.ts` — Captures `firstChunkMs` on first SSE byte; computes `ttfbMs` (firstChunk - start) and `gatewayOverheadMs` (upstreamStart - start) in flush()
- `src/index.ts` — Records `upstreamStartMs` immediately before provider.proxy(); passes to streaming context; added non-streaming trace recording with latency metrics
- `src/routes/dashboard.ts` — Added both fields to cursor and non-cursor trace listing SELECT queries

**Why:** Phase 1 latency observability requires visibility into both time-to-first-token and gateway processing overhead. No schema migration needed — columns already existed.

**Impact:** Backend trace system now emits complete latency breakdown; dashboard API returns both metrics per trace; frontend can display granular latency insights.

## 2026-02-25: M — Dashboard Display: TTFB + Overhead Visibility

**By:** McManus (Frontend)  
**Date:** 2026-02-25  
**Status:** Implemented

**What:** Surfaced `ttfb_ms` and `gateway_overhead_ms` in TracesTable and TraceDetails views.

**Changes Made:**
- `dashboard/src/components/TracesTable.tsx` — Updated `Trace` interface; added "Overhead" and "TTFB" columns after Latency, before Tokens (null-safe rendering)
- `dashboard/src/components/TraceDetails.tsx` — Added `<dt>`/`<dd>` pairs for both metrics with inline italic hints
- `dashboard/src/components/TraceDetails.css` — Added `.field-hint` style for inline label explanations

**Column Format:** `Xms` or `—` if null (backward compatible with older traces)

**Why:** Users need latency breakdown to diagnose performance bottlenecks. Inline hints improve accessibility over hover-only tooltips.

**Impact:** Latency observability complete end-to-end; users can distinguish gateway overhead from LLM response time; Phase 1 observability goals achieved.

## 2026-02-25: Startup Environment Variable Validation

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Status:** Implemented

**What:** Added boot-time validation for `ENCRYPTION_MASTER_KEY` environment variable in `src/index.ts`. If missing, gateway logs a warning to stderr but continues startup.

**Why:** Trace recording silently fails when `ENCRYPTION_MASTER_KEY` is missing (errors are caught and swallowed in `tracing.ts`). Operators discover the misconfiguration only after noticing missing traces (hours or days later). Boot-time warnings surface configuration issues immediately during startup.

**Implementation:** Added check after dotenv import that warns if `ENCRYPTION_MASTER_KEY` is not set.

**Pattern:** Fail-fast on config, fail-soft on runtime — configuration validation should be loud and early (boot time); runtime errors in non-critical paths (like trace recording) can be swallowed to avoid cascading failures; misconfiguration should never be silent at startup.

**Impact:** Operators see immediate feedback when required env vars are missing; gateway remains operational for proxying even without trace recording (graceful degradation); no breaking changes to existing deployments.

**Future Consideration:** This pattern could be extended to validate other critical env vars at boot time (e.g., `DATABASE_URL`, provider API keys).

## 2026-02-25: Schema Decisions: Multi-Tenant Management Migrations

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Migrations:** F-MT1 (1000000000007), F-MT2 (1000000000008)

**Decision 1: varchar(20) for Status Columns (Not PostgreSQL ENUMs)**

Both `tenants.status` and `api_keys.status` use `varchar(20)` with application-enforced valid values rather than PostgreSQL `ENUM` types.

**Why:** Adding new enum values to PostgreSQL ENUMs requires `ALTER TYPE` which locks the table. varchar allows adding new status values (e.g., `suspended`, `pending`) without schema migrations. Application layer can enforce validation via constants/types. Simpler rollback story (down migration just drops columns).

**Valid Values:** `tenants.status`: `active`, `inactive`; `api_keys.status`: `active`, `revoked`

**Impact:** Future status expansion doesn't require coordinated migrations; application code owns the enum contract.

**Decision 2: Nullable `revoked_at` vs Boolean `is_revoked`**

`api_keys.revoked_at` is a nullable `timestamptz` rather than a boolean flag.

**Why:** Tracks **when** the key was revoked (audit requirement). Can distinguish "never revoked" (NULL) from "revoked at time X". Single column serves both status indicator and timestamp purposes. Pairs with `status` column for filtering (`WHERE status = 'active'` is faster than `WHERE revoked_at IS NULL`).

**Impact:** Future audit queries can answer "how long was this key active?" without additional columns.

**Decision 3: Empty String Default for `key_prefix`**

`api_keys.key_prefix` defaults to empty string (`''`) rather than NULL.

**Why:** Simplifies UI rendering (no null checks needed in frontend). Key prefix is optional but when populated should always be a string. Empty string vs NULL distinction unnecessary for this field. NOT NULL + default empty avoids null handling in application layer.

**Impact:** Cleaner TypeScript types (`string` not `string | null`); fewer edge cases in dashboard.

**Decision 4: Automatic Backfill via DEFAULT Values**

Both migrations use `DEFAULT` clauses to backfill existing rows automatically during `ALTER TABLE`.

**Why:** Existing tenants get `status = 'active'`, `updated_at = now()` without separate UPDATE statements. Existing api_keys get `name = 'Default Key'`, `key_prefix = ''`, `status = 'active'` atomically. Single DDL statement (faster, less lock time). Idempotent migration (re-running doesn't duplicate backfill logic).

**Impact:** Zero-downtime migrations on existing data; no multi-step migration coordination needed.

**Decision 5: Index on Status Columns**

Both `tenants.status` and `api_keys.status` have dedicated indexes.

**Why:** Common query pattern: filter by status (`WHERE status = 'active'`). Low cardinality (2-3 values) but high selectivity (most rows are `active`). Supports dashboard queries that list active tenants or active keys. Index overhead minimal (single column, small data type).

**Impact:** Fast status-based filtering; supports future admin UI for tenant/key management.

## 2026-02-25: Multi-Tenant Management Design — Approved

**By:** Keaton (Lead), revised per Michael Brown's decisions (Q1–Q4)  
**Date:** 2026-02-25  
**Status:** Revised design incorporating all open questions resolved — ready for implementation

**Scope:** Phase 1 operational multi-tenancy (tenant CRUD, API key management, provider config management, dashboard admin interface)

**Key Decisions:**

1. **Q1 — Admin Auth (Per-User, Not Shared Secret):** New `admin_users` table (id, username, password_hash, created_at, last_login). `POST /v1/admin/login` endpoint validates bcrypt hash, returns 8h JWT (HS256, signed with `ADMIN_JWT_SECRET` env var). Admin auth middleware on all `/v1/admin/*` routes. Seed script (`scripts/create-admin.js`) for initial admin user creation. Dashboard stores JWT in `localStorage['loom_admin_token']`.

2. **Q2 — Deletion Strategy (Soft Default + Hard Delete Option):** Soft delete (default) via `PATCH /v1/admin/tenants/:id` with `status: "inactive"`. Hard delete via `DELETE /v1/admin/tenants/:id?confirm=true` — cascades through api_keys, traces, provider_config. API key soft revoke via `DELETE /v1/admin/tenants/:id/api-keys/:keyId` (sets status=revoked, revoked_at=now()). API key hard delete via `DELETE /v1/admin/tenants/:id/api-keys/:keyId?permanent=true`. Confirmation query params required on all destructive operations.

3. **Q3 — Provider Config Encryption (AES-256-GCM at Rest):** Reuses `src/encryption.ts` pattern (ENCRYPTION_MASTER_KEY + HMAC-SHA256 per-tenant key derivation). Provider `apiKey` encrypted before storing in `provider_config` JSONB column. Decrypted on read in `registry.ts` before passing to provider constructor. GET responses return `hasApiKey: boolean` — never raw or encrypted key.

4. **Q4 — Existing Data Backfill (Confirmed):** Migration defaults handle backfill for existing tenant and API keys. No additional migration logic needed — already designed correctly.

**API Endpoints:**
- `POST /v1/admin/login` — Public, no auth required. Returns JWT.
- `POST /v1/admin/tenants` — Create tenant
- `GET /v1/admin/tenants` — List all (paginated, filterable by status)
- `GET /v1/admin/tenants/:id` — Get tenant with provider config summary (keys redacted)
- `PATCH /v1/admin/tenants/:id` — Update name or status
- `DELETE /v1/admin/tenants/:id?confirm=true` — Hard delete with cascade
- `PUT /v1/admin/tenants/:id/provider-config` — Set/update provider config (encrypts apiKey at write)
- `DELETE /v1/admin/tenants/:id/provider-config` — Remove provider config
- `POST /v1/admin/tenants/:id/api-keys` — Create API key (raw key shown once)
- `GET /v1/admin/tenants/:id/api-keys` — List keys (no raw key/hash returned)
- `DELETE /v1/admin/tenants/:id/api-keys/:keyId` — Soft revoke (default)
- `DELETE /v1/admin/tenants/:id/api-keys/:keyId?permanent=true` — Hard delete

**Auth Middleware Update:** Skip `/v1/admin` routes in the tenant API key auth preHandler. Admin routes use dedicated JWT auth preHandler.

**DB Schema Migrations:**
- **F-MT1 (1000000000007):** `ALTER TABLE tenants ADD status varchar(20) DEFAULT 'active', ADD updated_at timestamptz DEFAULT now(); CREATE INDEX idx_tenants_status ON tenants (status);`
- **F-MT2 (1000000000008):** `ALTER TABLE api_keys ADD name varchar(255) DEFAULT 'Default Key', ADD key_prefix varchar(20) DEFAULT '', ADD status varchar(20) DEFAULT 'active', ADD revoked_at timestamptz; CREATE INDEX idx_api_keys_status ON api_keys (status);`
- **F-MT4a (1000000000009):** `CREATE TABLE admin_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(100) UNIQUE NOT NULL, password_hash varchar(255) NOT NULL, created_at timestamptz DEFAULT now(), last_login timestamptz);`

**Frontend Strategy:** Dedicated `/admin` page (not multi-tenant tenant switcher). Admin uses JWT auth via form login. Existing Traces/Analytics pages continue per-tenant (API key scope). Admin UI components: AdminLoginForm, TenantsList, TenantDetail (with provider config and API key management), CreateTenantModal, ProviderConfigForm, ApiKeysTable, CreateApiKeyModal.

**New Environment Variables:**
- `ADMIN_JWT_SECRET` — HS256 signing key for admin JWT tokens (required for startup if admin routes enabled)
- `ENCRYPTION_MASTER_KEY` — Already exists, reused for provider config encryption

**Why:** Addresses all Phase 1 operational multi-tenancy requirements. Per-user admin auth more secure than shared secret. Soft delete allows graceful deactivation; hard delete supports GDPR compliance. Provider key encryption consistent with existing encryption-at-rest architecture. Zero-downtime migrations via DEFAULT backfill.

**Impact:** Defines complete backend (F-MT1 through F-MT8) and frontend (M-MT1 through M-MT6) work breakdown for multi-tenant Wave (4 waves, critical path F-MT4a → F-MT4b → F-MT5 → F-MT8). Locks API surface and schema for Wave execution. Establishes admin/operator interface separate from tenant observability interface. No blockers identified; ready for implementation.

**Deferred to Phase 2:** RBAC per admin user, tenant self-service registration, audit logging for admin actions, rate limiting per tenant, multi-region routing.

## 2026-02-25: F-MT3/F-MT4a — Auth Middleware Enhancement & Admin Users Table

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Tasks:** F-MT3 (Auth Middleware), F-MT4a (Admin Users Migration)

**Decisions:**

1. **Admin Users Table:** New migration 1000000000009 creates `admin_users` table with per-user credentials (username, password_hash, created_at, last_login). Password hashing uses Node.js built-in `crypto.scrypt` (salt:derivedKey format) to avoid new dependencies. Migration seeds default admin user from env vars with idempotent `ON CONFLICT DO NOTHING`.

2. **Auth Middleware Query Enhancement:** Updated `lookupTenant()` in `src/auth.ts` to filter on `ak.status = 'active'` AND `t.status = 'active'`. Revoked keys and inactive tenants immediately rejected (no cache race conditions).

3. **Cache Invalidation Helpers:** Exported `invalidateCachedKey(keyHash)` for single key invalidation and `invalidateAllKeysForTenant(tenantId, pool)` for bulk invalidation on tenant deactivation. Bridges gap between management APIs (key ID) and cache layer (key hash).

**Why:** Foundation for JWT-based admin auth (F-MT4b). Enables safe deactivation of tenants/keys without lingering cache entries. No bcrypt dependency needed (Phase 1 constraint).

**Impact:** F-MT5–F-MT7 endpoints can safely invalidate caches. Auth tests (H-MT5) can validate revoked/inactive scenarios. Clean separation of concerns (auth.ts is responsible for its own cache invalidation).

## 2026-02-25: F-MT4b — JWT-Based Admin Authentication

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Task:** F-MT4b (JWT login endpoint, middleware, route scaffold)

**Decisions:**

1. **@fastify/jwt Integration:** Admin auth uses `@fastify/jwt` plugin (not jsonwebtoken) for native Fastify request/reply lifecycle integration. HS256-signed JWT with 8-hour expiry. `ADMIN_JWT_SECRET` env var required (warns at startup if missing).

2. **Login Endpoint:** `POST /v1/admin/login` accepts `{ username, password }`, verifies against `admin_users.password_hash` using same scrypt format as migration, returns `{ token, username }` on success, 401 on failure. Updates `last_login` timestamp.

3. **Admin Auth Middleware:** `src/middleware/adminAuth.ts` verifies Bearer tokens, attaches `request.adminUser` to request. All admin routes (except login) use this middleware via preHandler.

4. **Route Scaffold:** All 10 admin routes registered with 501 stubs (tenant CRUD 5, API key 3, provider config 2). Establishes API surface contract immediately — 501 clearly indicates "not implemented" vs 404 "doesn't exist".

5. **Auth Domain Separation:** Tenant API key auth and admin JWT auth are orthogonal — no shared middleware. Tenant auth on `/v1/chat/completions`, `/v1/traces`, `/v1/analytics/*`. Admin auth on `/v1/admin/*`. Skip list in tenant auth prevents conflicts.

**Why:** Per-user admin auth more auditable than shared secret. JWT stateless (no session store). 8-hour expiry balances session longevity (operator convenience) with security (limited token lifetime). Scrypt matches existing password storage (no new crypto dependencies).

**Impact:** Frontend can implement login form + JWT storage. Backend ready for F-MT5–F-MT7 CRUD implementation. Testing can focus on auth contract validation (H-MT1).

## 2026-02-25: F-MT5/F-MT6/F-MT7 — Complete Admin CRUD Implementation

**By:** Fenster (Backend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Tasks:** F-MT5 (Tenant CRUD), F-MT6 (API Key Management), F-MT7 (Provider Config)

**Decisions:**

1. **Tenant CRUD Endpoints:**
   - POST /v1/admin/tenants (201 with tenant row)
   - GET /v1/admin/tenants (paginated list with optional status filter, returns { tenants: [...], total })
   - GET /v1/admin/tenants/:id (detail with API key count + provider summary)
   - PATCH /v1/admin/tenants/:id (partial updates: name, status with cache invalidation on status change)
   - DELETE /v1/admin/tenants/:id?confirm=true (hard delete with cascade to api_keys, traces via FK)

2. **Cache Invalidation Workflow:** On PATCH status→inactive or DELETE, call `invalidateAllKeysForTenant()` before DB change. Ensures auth middleware rejects revoked tenant immediately.

3. **API Key Generation:** Format `loom_sk_` + 24-byte base64url (40 chars total, 192-bit entropy). `key_prefix` = first 12 chars (UI display). `key_hash` = SHA-256 hex (auth lookup). Raw key returned ONCE on creation.

4. **API Key Endpoints:**
   - POST /v1/admin/tenants/:id/api-keys (create, returns raw key once)
   - GET /v1/admin/tenants/:id/api-keys (list, no key material exposure)
   - DELETE /v1/admin/tenants/:id/api-keys/:keyId (soft revoke by default, hard delete with ?permanent=true)

5. **Provider Config Encryption:** Reuse `src/encryption.ts` (AES-256-GCM + per-tenant key derivation). Encrypt `apiKey` on write via `encryptTraceBody()`. Decrypt on read in `registry.ts` via `decryptTraceBody()`. GET responses return `hasApiKey: boolean` (never raw/encrypted key).

6. **Provider Config Endpoints:**
   - PUT /v1/admin/tenants/:id/provider-config (set/replace with provider-specific fields: openai/azure/ollama)
   - DELETE /v1/admin/tenants/:id/provider-config (clear config)

7. **Dynamic SQL Parameter Indexing:** PATCH queries with partial updates require careful index tracking (build updates array, push params, track paramIndex, append WHERE). Supports name-only, status-only, or both updates without code duplication.

8. **Parallel Queries:** List endpoint uses `Promise.all()` for tenants + total count (single round-trip, ~50% latency reduction).

**Why:** Complete operational multi-tenancy per Phase 1 scope. Soft delete allows graceful deactivation; hard delete supports GDPR compliance. Encryption consistent with existing architecture (single ENCRYPTION_MASTER_KEY env var). Parallel queries optimize hot path. Dynamic SQL supports flexible updates.

**Impact:** Frontend can implement full admin UI (M-MT1–M-MT6). All 10 endpoints provide complete tenant lifecycle. Hockney can write integration tests (28 tests, H-MT1–H-MT5). Ready for production deployment.

## 2026-02-25: M-MT1 — Admin API Utility Module & Login Component

**By:** McManus (Frontend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Task:** M-MT1 (Admin API utilities + AdminLogin component)

**Decisions:**

1. **Admin API Utilities:** New `dashboard/src/utils/adminApi.ts` with `adminFetch()` that auto-redirects to `/dashboard/admin` on 401 or missing token. Token managed in `localStorage['loom_admin_token']`. Export helper functions: `getAdminToken()`, `setAdminToken()`, `clearAdminToken()`.

2. **Type Exports:** Define `AdminTenant`, `AdminApiKey`, `AdminProviderConfig` interfaces (co-located with API module for single import source). Match backend schema with `hasApiKey: boolean` instead of raw/encrypted keys.

3. **AdminLogin Component:** Username + password form, localStorage token persistence (8h lifetime matches backend JWT expiry). Submit disabled until both fields non-empty. Error handling inline (red box below password). Loading state during fetch.

4. **localStorage Strategy:** Persist admin JWT across page reloads + browser restarts (matches 8h session model). Alternative sessionStorage rejected (forces re-login on new tabs, poor UX for multi-tab workflows).

5. **Styling Consistency:** Follow existing `ApiKeyPrompt.css` patterns (overlay, card, input, button, error states). Responsive design inherited from existing components.

**Why:** Standard JWT + localStorage pattern (proven security model). Mirroring existing ApiKeyPrompt reduces design decisions. Co-located types simplify imports. Auto-redirect on 401 centralizes auth failure handling.

**Impact:** Clean foundation for admin UI components (M-MT2+). No custom crypto on frontend (backend signs/verifies JWT). Form handling is simple React state.

## 2026-02-25: M-MT2 — Admin Page Shell & Route Registration

**By:** McManus (Frontend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Task:** M-MT2 (Admin page shell, /admin route, nav link)

**Decisions:**

1. **AdminPage Component:** Check `localStorage['loom_admin_token']` on mount. If missing, render `<AdminLogin onLogin={callback} />`. If token exists, render admin shell with placeholder + logout button. Logout clears token and resets state (no page reload).

2. **Token-Driven Login/Logout:** State-driven flow (not redirect-based) keeps navigation smooth. AdminLogin handles all auth logic; AdminPage orchestrates flow.

3. **Route Registration:** Added `/admin` route in App.tsx alongside existing `/` (Traces) and `/analytics` routes. No changes to existing routes/components.

4. **Navigation Link:** Added "Admin" link to Layout.tsx navigation bar after "Analytics". Uses same active state detection pattern as existing links.

5. **Placeholder Approach:** Phase 1 renders minimal shell (header + logout button). Real admin UI (tenant list, detail, etc.) implemented in M-MT3+ (blocked on F-MT5 endpoint completion).

**Why:** Token check on mount avoids unnecessary API calls. State-driven flow simplifies component logic. Placeholder unblocks routing integration while backend is being completed. Consistent styling with existing app.

**Impact:** Admin route fully registered and navigable. Auth gate working (login required, logout clears token). Ready for M-MT3+ detail view components.

## 2026-02-25: M-MT3/M-MT4/M-MT5/M-MT6 — Complete Admin Dashboard UI

**By:** McManus (Frontend)  
**Date:** 2026-02-25  
**Status:** Complete  
**Tasks:** M-MT3 (TenantsList + CreateTenantModal), M-MT4 (TenantDetail), M-MT5 (ProviderConfigForm), M-MT6 (ApiKeysTable + CreateApiKeyModal)

**Decisions:**

1. **TenantsList Component:**
   - GET /v1/admin/tenants on mount
   - Loading state: 3 skeleton shimmer rows
   - Error state: retry button
   - Empty state: friendly copy
   - Table columns: Name, Status (badge), API Keys (placeholder), Created (formatted date)
   - Row click navigates to detail view (state-based, not URL routing)
   - "New Tenant" button opens CreateTenantModal

2. **CreateTenantModal:**
   - Single text input for tenant name
   - POST /v1/admin/tenants
   - Inline error display on failure
   - Success: calls `onCreated` callback + closes modal
   - Click-outside and Escape dismiss
   - Loading state prevents double-submit

3. **State-Based Navigation:** Use React state (`selectedTenantId`) to switch between list and detail views (not URL routing). Simpler for Phase 1; TenantsList takes `onTenantSelect` prop; TenantDetail takes `onBack` prop.

4. **TenantDetail Component:**
   - GET /v1/admin/tenants/:id on mount
   - Inline name editing (PATCH)
   - Status toggle: "Deactivate" (if active) / "Reactivate" (if inactive)
   - Danger zone: permanent delete with confirmation
   - Renders ProviderConfigForm + ApiKeysTable as sections

5. **ProviderConfigForm:**
   - Display current config (provider, baseUrl, hasApiKey indicator with "🔒 Set (encrypted)")
   - Provider select (openai, azure, ollama)
   - API key field (password input, leave blank on update to keep existing)
   - Azure-specific fields: deployment, apiVersion (conditional rendering)
   - PUT /v1/admin/tenants/:id/provider-config
   - "Remove Config" button with inline confirmation

6. **ApiKeysTable:**
   - List keys: name, prefix, status badge, created/revoked dates
   - "Create API Key" button → opens CreateApiKeyModal
   - "Revoke" button (active keys) → confirmation → soft delete
   - "Delete" button (revoked keys) → permanent delete with ?permanent=true
   - Empty state

7. **CreateApiKeyModal (Two-Stage):**
   - Stage 1: form with key name → POST /v1/admin/tenants/:id/api-keys
   - Stage 2: raw key display with copy button + warning "You won't see this again"
   - Click-outside disabled when key shown (requires explicit "Done")
   - Forces acknowledgment before closing

8. **Confirmation Patterns:**
   - Inline expansion: low-risk operations (provider config delete)
   - In-component warning section: high-impact operations (tenant delete)
   - Browser confirm(): quick actions (API key revoke/delete)
   - Raw key display: explicit acknowledgment required (forced "Done", not "Close")

9. **Type Additions:** Extended `AdminProviderConfig` with optional `deployment?` and `apiVersion?` fields for Azure support.

10. **Modal Styling:** Follow existing patterns (click-outside dismiss, Escape handler, responsive overlays).

**Why:** Complete admin UI per backend API contract. State-based navigation simple for Phase 1 scope. Confirmation patterns match severity of operations. Raw key one-time display + forced acknowledgment is security best practice (GitHub, AWS pattern).

**Impact:** Full admin dashboard functional end-to-end. TenantsList → detail → provider config + API keys all wired. Ready for E2E testing with backend. No URL routing complexity; state management straightforward.

## 2026-02-25: H-MT1 through H-MT5 — 28 Admin Integration Tests

**By:** Hockney (Tester)  
**Date:** 2026-02-25  
**Status:** Complete  
**Tasks:** H-MT1–H-MT5 (Admin auth, tenant CRUD, API key management, provider config, auth regression)

**Decisions:**

1. **Test Architecture:** Mocked pg.Pool with 15+ query handlers covering all admin routes + auth middleware. No real PostgreSQL; all tests run in <2s total. In-process testing via fastify.inject() eliminates port allocation flakiness.

2. **Mock Query Coverage:**
   - Admin user login (scrypt password verification)
   - Tenant CRUD with conditional UPDATE (partial updates)
   - API key soft/hard delete with status transitions
   - Provider config encryption/decryption simulation
   - Auth middleware tenant lookup (multi-space SQL formatting)
   - Cache invalidation helper queries (SELECT key_hash by tenant)

3. **Cache Invalidation Discovery:** Auth middleware uses module-level LRU cache singleton persisting across test runs. H-MT5 regression tests initially failed because first test cached values, subsequent tests with modified mock data still read stale cache. **Solution:** Call `invalidateCachedKey()` in beforeEach for H-MT5 suite. **Implication:** Future test authors must explicitly clear cache for auth regression scenarios (not obvious, documented in history).

4. **Test Coverage (28 tests):**
   - H-MT1: Admin auth middleware (6 tests) — JWT verification, bearer tokens, 401 handling
   - H-MT2: Tenant CRUD (10 tests) — create, list, detail, update, delete with cache validation
   - H-MT3: API key management (5 tests) — create, list, soft revoke, hard delete
   - H-MT4: Provider config (4 tests) — CRUD with encryption round-trip
   - H-MT5: Auth regression (3 tests) — revoked keys, inactive tenants, cache invalidation

5. **No Health Check Endpoint Gap Addressed:** Admin routes lack dedicated `/v1/admin/health` endpoint. All routes except login require JWT. **Observation:** No easy smoke test for "is admin API alive?". **Recommendation:** Consider adding health endpoint in Phase 2 for monitoring/load balancer checks.

**Why:** Comprehensive coverage validates entire admin API surface. Mock pg.Pool avoids PostgreSQL dependency. Findings (cache invalidation requirement, health check gap) documented for team learnings.

**Impact:** All 28 tests passing (113 total suite, 100% pass rate). Admin API endpoints ready for production deployment. Cache invalidation behavior well-understood for future work.

## 2026-02-25: Multi-Tenant Admin Feature — Implementation Complete

**By:** Fenster, McManus, Hockney  
**Date:** 2026-02-25  
**Status:** Complete  
**Summary:** All Phase 1 multi-tenant management API and admin dashboard UI fully implemented and tested.

**Scope:** 
- Backend: 10 CRUD endpoints (tenant, API key, provider config management)
- Frontend: 6 admin UI components (login, list, detail, config form, key management)
- Tests: 28 integration tests (auth, CRUD, encryption, regression)

**Key Achievements:**
- JWT-based per-user admin authentication (not shared secret)
- Encryption-at-rest for provider API keys (AES-256-GCM + per-tenant derivation)
- Soft-delete by default with hard-delete option (GDPR compliance)
- Cache invalidation helpers for immediate auth rejection on mutations
- State-based navigation in admin dashboard (no URL routing complexity)
- Raw API key display once on creation with forced acknowledgment
- Comprehensive integration test suite with cache invalidation validation

**Build Status:**
- ✅ Backend: Clean compile (npm run build)
- ✅ Frontend: Clean compile (711 modules, 600.82 kB)
- ✅ Tests: All passing (npm test)

**Phase 2 Deferrals:**
- Audit logging per admin action
- RBAC per admin user (read-only, operator, super-admin)
- Tenant usage limits and cost budgets
- API key rotation workflows
- External KMS integration
- Admin health check endpoint

**Ready for:** Production deployment validation, user acceptance testing, integration with existing observability dashboard.

## 2025-07-24: Tenant Portal Architecture Approved

**By:** Keaton (Lead), approved by Michael Brown  
**What:** Complete architecture for tenant self-service portal — separate React SPA (`portal/`), 7 backend routes (`/v1/portal/*`), `tenant_users` table with scrypt passwords, separate JWT namespace (`PORTAL_JWT_SECRET`), provider API key encryption, email-globally-unique design  
**Why:** Phase 1 requires tenant onboarding without admin access; signup/login flows, provider configuration, and API key self-management; email uniqueness simplifies initial implementation  
**Impact:** Defines work breakdown for Fenster (portal backend, migration, auth middleware), McManus (portal React SPA, 6 pages, 4 components); unblocks tenant adoption without admin provisioning; establishes separate auth domain (portal JWT vs admin JWT) for security isolation

## 2025-07-24: Portal Backend Implementation Notes

**By:** Fenster (Backend Dev)  
**What:** Implementation decisions for portal backend: JWT registered at top-level Fastify instance, `registerPortalAuthMiddleware` returns route-level preHandler (not hook), `keyPrefix` = 15 chars (per spec), email stored lowercase at app layer, scrypt format `salt:derivedKey` consistent with admin_users  
**Why:** Ensure JWT availability during route registration, match admin auth pattern, follow Keaton's spec exactly, prevent email case-sensitivity issues  
**Impact:** Portal auth middleware fully isolated from admin auth via Fastify namespace; signup/login endpoints establish email-based identity; rate limiting TODO for future work

## 2025-07-24: Tenant Portal Frontend Decisions

**By:** McManus (Frontend Dev)  
**What:** Design decisions for portal React SPA: color palette matches dashboard (gray-950/900, indigo-600), ApiKeyReveal component reused in both signup and key creation, ProviderConfigForm extracted as reusable component, JWT stored as `loom_portal_token` (separate from `loom_admin_token`), no basename for React Router (portal serves at `/`)  
**Why:** Visual consistency across both SPAs, reduce component duplication, clean auth domain separation, simplify production serving (no path prefix needed)  
**Impact:** Unified Loom UI aesthetic; ApiKeyReveal establishes "show once" pattern for sensitive keys; ProviderConfigForm enables reuse in future admin dashboard; state-based navigation (selectedTenantId) supports scalable admin UI without URL routing complexity

## 2026-02-26: Admin Trace & Analytics Endpoints

**By:** Fenster (Backend Dev)  
**Status:** Implemented  
**Date:** 2026-02-26

### Context

The admin dashboard previously had no way to view traces across tenants — `/v1/traces` is scoped to the API key's tenant. Admin operators need visibility into all tenant activity.

### Decisions

**1. Separate admin analytics functions, not overloading existing ones**

`getAnalyticsSummary` and `getTimeseriesMetrics` in `analytics.ts` take a required `tenantId`. Rather than making `tenantId` optional on the existing functions (which could mask callers that accidentally omit it), we added:
- `getAdminAnalyticsSummary(tenantId?: string, windowHours?)`
- `getAdminTimeseriesMetrics(tenantId?: string, windowHours?, bucketMinutes?)`

Per-tenant dashboard routes remain unchanged and continue to pass a required `tenantId`.

**2. Dynamic SQL parameter numbering via `params.push()`**

Admin queries conditionally include a `tenant_id` filter. We use `params.push(value)` inside template literals — `Array.push` returns the new array length, giving us the correct `$N` placeholder inline. Clean and avoids string-splitting logic.

**3. `$1` = `limit` in admin traces query**

The `LIMIT` binding is always `$1` so it appears at the top of the query. All `WHERE` filter params are pushed after, yielding `$2`, `$3` etc. This keeps the query readable and consistent regardless of which filters are active.

**4. Endpoints protected by `adminAuthMiddleware` (JWT)**

All three new endpoints use the `authOpts = { preHandler: adminAuthMiddleware }` pattern already established in `admin.ts`. No API-key auth is involved — these are admin-only surfaces.

### New Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/admin/traces` | Admin JWT |
| GET | `/v1/admin/analytics/summary` | Admin JWT |
| GET | `/v1/admin/analytics/timeseries` | Admin JWT |

### Impact

- `src/analytics.ts` — two new exported functions added (non-breaking)
- `src/routes/admin.ts` — three new GET routes, two new imports (`getAdminAnalyticsSummary`, `getAdminTimeseriesMetrics`, `query`)

## 2026-02-26: Admin Dashboard Split — Separate Auth + Tenant Filter

**By:** McManus (Frontend Dev)  
**Status:** Implemented  
**Date:** 2026-02-26

### Context

The admin dashboard previously used an API key (stored in `localStorage.loom_api_key`) to call the tenant-scoped `/v1/traces` endpoint. This meant an admin could only see one tenant's data at a time — whichever tenant's API key they had loaded. There was no way to browse across tenants.

Simultaneously, the tenant portal (portal/) had no traces or analytics UI — tenants couldn't see their own request history.

### Decision

**Admin Dashboard:**
- Switch TracesPage and AnalyticsPage from API key auth to admin JWT (`localStorage.loom_admin_token`, managed by `adminApi.ts`)
- Call the new admin endpoints: `/v1/admin/traces`, `/v1/admin/analytics/summary`, `/v1/admin/analytics/timeseries`
- Add a tenant filter dropdown above traces/analytics; fetches tenant list from `/v1/admin/tenants`
- No API key prompt shown for admin dashboard — if admin token missing, show a sign-in link instead

**Portal:**
- Add `/app/traces` → TracesPage (tenant-scoped, JWT auth, calls `/v1/traces`)
- Add `/app/analytics` → AnalyticsPage (tenant-scoped, JWT auth, calls `/v1/analytics/summary` + timeseries)
- Add Traces and Analytics nav links to AppLayout sidebar

### Implementation Pattern

Added `adminMode?: boolean` and `tenantId?: string` props to `TracesTable`, `AnalyticsSummary`, `TimeseriesCharts`. When `adminMode` is true:
- Use `ADMIN_BASE` (from adminApi.ts) instead of `API_BASE`
- Use `adminAuthHeaders()` (Bearer admin JWT) instead of `authHeaders()` (Bearer API key)
- Append `?tenant_id=X` when a tenant is selected

This pattern keeps the component API minimal. The alternative — passing full endpoint URLs and header factories as props — would cause useCallback dependency issues with inline functions.

### Scope Boundaries

- Did **not** build admin analytics charts for per-tenant comparison — deferred to future wave
- Did **not** add real-time refresh to portal traces — not required for Phase 1
- Portal analytics shows a data table (buckets) rather than recharts visualization — portal doesn't have recharts dep; table is sufficient for Phase 1 observability
- Architecture decisions (endpoint shapes, auth model) remain Fenster's domain; this PR purely consumes Fenster's new admin endpoints

### Files Changed

- `dashboard/src/pages/TracesPage.tsx` — admin auth, tenant filter
- `dashboard/src/pages/AnalyticsPage.tsx` — admin auth, tenant filter
- `dashboard/src/components/TracesTable.tsx` — adminMode/tenantId props
- `dashboard/src/components/AnalyticsSummary.tsx` — adminMode/tenantId props
- `dashboard/src/components/TimeseriesCharts.tsx` — adminMode/tenantId props
- `portal/src/pages/TracesPage.tsx` — new file
- `portal/src/pages/AnalyticsPage.tsx` — new file
- `portal/src/App.tsx` — two new routes
- `portal/src/components/AppLayout.tsx` — two new nav links
# Decision: Chart Interactions — Drag-to-Reorder & Expand Toggle

**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Author:** McManus (Frontend)
**Status:** Implemented

## Decision

Used the native HTML5 Drag and Drop API for chart reordering instead of a third-party library (react-dnd, dnd-kit).

## Rationale

- Keeps bundle lean — no new dependencies
- HTML5 DnD API is sufficient for a 4-card grid reorder scenario
- Task constraint explicitly required this approach

## Layout Change

Migrated `TimeseriesCharts` from `flex-column` to a 2-column CSS grid. This is a visual change that affects how charts appear (side-by-side at ≥769px). Keaton should be aware in case this affects any screenshot tests or embedding contexts.

## Persistence

Chart order and expanded state are stored in `localStorage` under key `loom-chart-prefs` as `{ order: string[], expanded: string[] }`. No backend state required.

## Files Changed

- `shared/analytics/TimeseriesCharts.tsx`
- `shared/analytics/TimeseriesCharts.css`

---

# Multi-User Multi-Tenant Architecture

**Author:** Keaton (Lead)  
**Date:** 2026-02-26  
**Status:** Proposed — awaiting Michael Brown approval  
**Requested by:** Michael Brown  
**Scope:** Multiple users per org/tenant via invite links; users can belong to multiple tenants

## 1. Problem Statement

Current model: `tenant_users` table enforces 1:1 user↔tenant (email is `UNIQUE`). A user signs up, creates a tenant, and can never belong to another. Org owners cannot invite collaborators.

**Required:**
1. Org owner creates invite links → other users sign up or join under that invite
2. A single user (email) can belong to multiple tenants
3. Users can switch between their tenants in the portal UI

## 2. Schema Changes

### 2.1 New `users` Table (Auth Identity)

Separates authentication identity from tenant membership. Email is the unique auth key.

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users (email);
```

### 2.2 New `tenant_memberships` Junction Table

Replaces the 1:1 `tenant_users` table. One user can have multiple memberships.

```sql
CREATE TABLE tenant_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       VARCHAR(50) NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, tenant_id)
);

CREATE INDEX idx_tenant_memberships_user_id   ON tenant_memberships (user_id);
CREATE INDEX idx_tenant_memberships_tenant_id ON tenant_memberships (tenant_id);
```

**Roles:** `owner` | `member`
- **owner:** manage invites, manage members, manage settings, manage API keys, view traces/analytics
- **member:** view traces/analytics (read-only)

This maps cleanly to the existing `ownerRequired` vs `authRequired` preHandler pattern in portal routes.

### 2.3 New `invites` Table

```sql
CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token       VARCHAR(64) NOT NULL UNIQUE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses    INTEGER,          -- NULL = unlimited
  use_count   INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,      -- NULL = active; set = revoked
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invites_token     ON invites (token);
CREATE INDEX idx_invites_tenant_id ON invites (tenant_id);
```

**Invite token format:** 32 bytes, base64url-encoded (43 chars). Generated via `crypto.randomBytes(32).toString('base64url')`.

**Invite link URL:** `{PORTAL_BASE_URL}/signup?invite={token}`

### 2.4 Drop `tenant_users` Table

The old `tenant_users` table is fully replaced by `users` + `tenant_memberships`. Data migrated before drop.

## 3. JWT Strategy

### Decision: Keep `tenantId` in JWT, Switch via New Token

**Current JWT payload:** `{ sub: userId, tenantId: string, role: string }`  
**New JWT payload:** `{ sub: userId, tenantId: string, role: string }` — **identical structure**

**Rationale:** Every existing portal route reads `request.portalUser.tenantId` from the JWT. Keeping `tenantId` in the JWT means zero changes to middleware and zero changes to any existing route handler. The multi-tenant capability is additive.

**How switching works:**
1. Login returns `tenants[]` alongside the JWT (JWT issued for the first/default tenant)
2. Frontend stores the tenants list in memory/state
3. User clicks a different tenant in the switcher
4. Frontend calls `POST /v1/portal/auth/switch-tenant { tenantId }` 
5. Backend validates membership, issues a new JWT with the new `tenantId`
6. Frontend replaces the stored token and refreshes data

## 4. API Endpoints (15 total)

### Modified Endpoints
- `POST /v1/portal/auth/signup` — added `inviteToken` branch
- `POST /v1/portal/auth/login` — returns `tenants[]` array
- `GET /v1/portal/me` — returns `tenants[]` array

### New Auth Endpoint
- `POST /v1/portal/auth/switch-tenant` — switch active tenant, get new JWT

### New Invite Endpoints
- `POST /v1/portal/invites` — create invite (owner only)
- `GET /v1/portal/invites` — list invites (owner only)
- `DELETE /v1/portal/invites/:id` — revoke invite (owner only)
- `GET /v1/portal/invites/:token/info` — public, no auth

### New Member Management Endpoints
- `GET /v1/portal/members` — list members (any role)
- `PATCH /v1/portal/members/:userId` — update role (owner only)
- `DELETE /v1/portal/members/:userId` — remove member (owner only)

### New Tenant List / Leave Endpoints
- `GET /v1/portal/tenants` — list user's tenants
- `POST /v1/portal/tenants/:tenantId/leave` — leave tenant

## 5. Frontend Changes

### TenantSwitcher Component (Sidebar)
- Dropdown showing current tenant (or static text if only 1)
- List of all tenants from `tenants[]`
- Click triggers `POST /v1/portal/auth/switch-tenant`

### Updated Signup Flow
- Route: `/signup?invite={token}`
- Call `GET /v1/portal/invites/:token/info` to display tenant name
- Show "Join {tenantName}" form instead of org creation form
- Submit with `inviteToken` branch

### Members & Invites Page (`/app/members`)
- Members list with role badges, joined date, last login
- Invite management (create, list with use counts, revoke)
- Owner-only actions (role change, member removal)

### AuthContext
- Unified state: `token`, `user`, `tenant`, `tenants[]`, `loading`
- `useAuth()` hook for all components
- Handles `switchTenant()` action

### Navigation Updates
- Add Members link (owner-only visibility)
- Keep existing API Keys link

## 6. Migration Strategy

Single migration `1000000000011_multi_tenant_users.cjs`:
1. Create `users` table from `tenant_users` data
2. Create `tenant_memberships` junction table from `tenant_users` relationships
3. Create `invites` table (starts empty)
4. Drop `tenant_users` table

Data preserved: all existing users remain owners of their current tenant.

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration data loss on rollback | Users with multiple memberships lose all but first | Document as known limitation; take DB backup |
| JWT tenantId stale after removal | User removed but JWT still valid | JWT has 24h expiry; membership check on sensitive ops |
| Invite token brute force | Attacker guesses tokens | 32-byte random = 256-bit entropy; rate limit deferred to Phase 2 |
| Last-owner removal race condition | Two owners demote each other simultaneously | Use `SELECT ... FOR UPDATE` deferred to Phase 2 |

## 8. Phase 2 Deferred

- Email notifications for invites
- Invite role customization
- Tenant creation limits per user
- Transfer tenant ownership
- User profile management (change email, change password)
- Rate limiting on invite endpoints
- Audit logging for membership changes
- Last-owner race condition fix

---

# Multi-User Multi-Tenant: Backend Implementation Decisions

**Author:** Fenster (Backend Dev)  
**Date:** 2026-02-26

## Decision 1: `inviteToken` branch silently ignores `tenantName`

**Context:** The spec says "When inviteToken is present, tenantName is ignored." The body type was widened to make `tenantName` optional.

**Decision:** No error is returned if `tenantName` is supplied alongside `inviteToken`. It is simply unused. This is the least-friction path for frontend clients that might always send all fields.

## Decision 2: Existing user joining via invite does NOT re-hash password

**Context:** When an existing user joins a second tenant via invite (email already exists in `users`), the invite flow skips password hashing entirely.

**Decision:** The existing user's credentials are untouched. The signup-via-invite path for existing users is essentially "add membership to my existing account." The password field in that case is superfluous.

## Decision 3: Login returns 403 (not 401) for zero active memberships

**Context:** A user could exist in `users` with no active tenant memberships (e.g., all tenants deleted).

**Decision:** Return 403 with `{ error: 'No active tenant memberships' }`. Authentication succeeded; the user simply has no accessible tenants. This is an authorization failure, not authentication.

## Decision 4: `PORTAL_BASE_URL` declared inside `registerPortalRoutes`

**Context:** The spec calls for `PORTAL_BASE_URL` from env, defaulting to `http://localhost:3000`.

**Decision:** Read `process.env.PORTAL_BASE_URL` inside the function body. This ensures the value is captured after `.env` file loading and allows test overrides without module re-imports.

## Decision 5: Soft-revoke only for invites

**Context:** Spec says `DELETE /v1/portal/invites/:id` sets `revoked_at = now()`.

**Decision:** Implemented exactly as spec. Hard-delete was not used because preserving revoked invites maintains an audit trail. The `isActive` computed field correctly reflects revoked status.

## Decision 6: `GET /v1/portal/invites/:token/info` — 404 for unknown, `isValid: false` for expired

**Context:** Spec says "Always returns `isValid: false` (not 404) for expired/revoked/exhausted tokens — prevents token enumeration."

**Decision:** Unknown token → 404. Known token but invalid (expired/revoked/exhausted/tenant inactive) → 200 with `isValid: false`.

## Decision 7: No `SELECT ... FOR UPDATE` on last-owner checks

**Context:** Spec notes a risk of race condition on last-owner count check.

**Decision:** Deferred to Phase 2 per spec. Missing FOR UPDATE means concurrent requests could both read "2 owners" and both proceed to demote, leaving zero owners. Acceptable for initial release.

## Decision 8: Migration preserves `tenant_users.id` as `users.id`

**Context:** Audit reveals no other tables reference `tenant_users.id`.

**Decision:** IDs are preserved verbatim in migration INSERT. Any existing JWTs (which embed `userId` = old `tenant_users.id`) remain valid immediately after migration without token refresh.

---

# Multi-User Multi-Tenant: Frontend Implementation Decisions

**Author:** McManus (Frontend Dev)  
**Date:** 2026-02-26

## Decision 1: AuthContext as Single Source of Auth Truth

**Context:** Previously, each page component individually called `api.me()` on mount. Tenant switching requires replacing the token and refreshing state app-wide.

**Decision:** Created `portal/src/context/AuthContext.tsx` wrapping the entire app. All components use `useAuth()` hook. AuthContext owns: `token`, `user`, `tenant`, `tenants[]`, `loading`.

**Rationale:** Tenant switching needs to propagate instantly to all components. A context is the minimal correct solution.

## Decision 2: `currentRole` Derivation Strategy

**Context:** Role lives in JWT but also in `tenants[]` list returned from login/me.

**Decision:** `currentRole` is derived as:
```ts
tenants.find(t => t.id === tenant?.id)?.role ?? user?.role ?? null
```
Falls back to `user.role` for backward compatibility.

## Decision 3: Members Nav Link — Hide vs. Gate

**Choice:** Hide the Members nav link entirely for non-owners (not show disabled).

**Rationale:** Members without the link visible won't try to navigate there. The page itself still gates API. Consistent with how API Keys work.

## Decision 4: Invite Signup → Redirect to `/app/traces`

**Per spec:** On successful invite-based signup, navigate to `/app/traces` (not API key reveal, since members don't get keys).

**Implementation:** API `signup` response `apiKey` made optional (`apiKey?`).

## Decision 5: Tenant Switcher — No Page Reload

**Decision:** `switchTenant()` calls `POST /v1/portal/auth/switch-tenant`, replaces token, then calls `api.me()` to refresh context. No `window.location.reload()`.

**Rationale:** In-place state update is smoother UX. Any component subscribed to context will re-render automatically.

**Known limitation:** Pages that fetched data on mount will show stale data until navigation/refresh. Acceptable for Phase 1.

## Decision 6: Revoked Invites — Collapsed `<details>`

**Decision:** Revoked/expired invites shown in collapsed `<details>` element below active invites table.

**Rationale:** Keeps page clean. Owners rarely need historical revoked invites. No new dependencies.

---

# Portal & Analytics UI Test Coverage

**Author:** Hockney (Test Suite Generation)  
**Date:** 2026-03-01  
**Status:** Complete

## Portal Pages Tests (Agent 33)

8 portal pages with 51 comprehensive test cases:
- AgentsPage
- ApiKeysPage
- AnalyticsPage
- ConversationsPage
- MembersPage
- SettingsPage
- SubtenantsPage
- TracesPage

All tests passing. Coverage includes component rendering, user interactions, API integration, and edge cases.

## Analytics UI Components Tests (Agent 34)

5 shared analytics components with 38 comprehensive test cases:
- AnalyticsSummary
- AnalyticsPage
- TimeseriesCharts
- ModelBreakdown
- TenantSelector

Infrastructure improvements:
- Recharts mock for chart component testing
- tsconfig.json @/shared resolve alias

All tests passing. Suite total: 502 tests.

**Commit:** c25c81c

---

# Architecture Document Created

**By:** Keaton (Lead)  
**Date:** 2026-02-27  
**Status:** Active

`docs/architecture.md` is now the **canonical architecture reference** for Loom.

## What Was Created

A 13-section architecture document grounded in the actual codebase, covering:

1. System Overview
2. High-Level Architecture (Mermaid diagram)
3. Component Breakdown (gateway, services, domain, infrastructure, routes, frontends)
4. Request Data Flow (sequence diagrams for streaming and non-streaming)
5. Multi-Tenancy Model (ER diagram, isolation mechanics, lifecycle)
6. Authentication & Authorization (three auth domains)
7. Database & Persistence (MikroORM, migrations, partitioning)
8. Analytics Pipeline (on-read SQL, cost estimation, subtenant rollup)
9. Provider Abstraction (class diagram, adapter patterns)
10. Encryption (AES-256-GCM envelope encryption)
11. Testing Strategy (Vitest, test patterns, coverage)
12. Configuration & Deployment (env vars, docker-compose, service topology)
13. Key Design Principles

## Impact

- README.md Architecture section updated to link to `docs/architecture.md`
- All future architecture discussions should reference this document
- Document reflects code-as-built, not aspirational design

## Maintenance

This document should be updated when:
- New services, routes, or providers are added
- Migration strategy changes
- Service topology changes (e.g., Phase 2 service split)
- Auth model changes

---

# Decision: Use `jsonwebtoken` directly for JWT signing/verification

**Date:** 2026-03  
**Author:** Fenster (Backend Dev)  
**Status:** Accepted

## Context

Loom had two separate JWT implementations:
- Admin routes used `@fastify/jwt` (Fastify plugin), calling `fastify.jwt.sign()` and `request.jwtVerify()`
- Portal routes used `fast-jwt` (`createSigner`/`createVerifier`)

This created unnecessary coupling to framework plugins and two different JWT libraries.

## Decision

Consolidate onto `jsonwebtoken` directly, with a shared `signJwt`/`verifyJwt` utility in `src/auth/jwtUtils.ts` and a generic preHandler factory `createBearerAuth` in `src/middleware/createBearerAuth.ts`.

## Rationale

- **No framework coupling**: `jsonwebtoken` works without registering a Fastify plugin; logic is portable and testable in isolation
- **Single library**: eliminates `fast-jwt` and `@fastify/jwt` as dependencies
- **Shared factory pattern**: `createBearerAuth` handles header extraction, verification, and 401 response uniformly for both admin and portal auth
- **Explicit secrets**: secrets are read from env vars in the middleware/service files directly, not passed through plugin registration

## Consequences

- `@fastify/jwt` and `fast-jwt` removed from `package.json`
- `jsonwebtoken` + `@types/jsonwebtoken` added
- 401 error messages unified to `{ error: 'Unauthorized' }` (no longer distinguishes missing header from invalid token)
- `ADMIN_JWT_SECRET` and `PORTAL_JWT_SECRET` remain as separate env vars
- `request.adminUser` and `request.portalUser` shapes unchanged
# Decision: GitHub Issue Backlog Created

**Date:** 2026-02-27  
**Author:** Keaton (Lead)

## Summary

A full GitHub issue backlog has been created for Loom at `Goalglowup/loom`.

## Details

- **10 epics** created (issues #18–#27), labeled `epic`, covering all planned Phase 2 and Phase 3 work areas
- **27 stories** created (issues #28–#54), labeled `story`, written from user POV with acceptance criteria and dev task checkboxes
- All epic bodies updated with links to their constituent stories
- Stories span: Admin Dashboard, Cost Management, Error Analytics, Agent Analytics, Security & Compliance, Streaming/MCP, Developer Experience, Multi-Tenant Management, Conversation Management, Provider Management

## Phase Distribution
- Phase 1 (Admin Dashboard): 3 stories
- Phase 2: 21 stories
- Phase 3: 3 stories (5.3, 8.2, 9.3)
# Analytics Recommendations for Loom Gateway

**By:** Redfoot (Data Engineer)  
**Date:** 2026-03-01  
**Status:** Proposed  

## Context

Loom users fall into distinct personas with different analytics needs:
- **Tenant Operators** (managing costs, monitoring usage patterns, forecasting spend)
- **Developers** (debugging failures, optimizing performance, understanding bottlenecks)
- **Product Teams** (tracking adoption, feature usage, user behavior)
- **Finance Teams** (cost attribution, budget tracking, chargeback)
- **Platform Admins** (system health, capacity planning, abuse detection)

Current analytics provide foundational metrics (requests, tokens, cost, latency, errors, model breakdown, time-series). The following recommendations extend this foundation.

---

## Priority 1: Cost Management & Attribution

### 1.1 Cost Breakdown by Dimension
**What:** Multi-dimensional cost views beyond just model breakdown  
**Why:** Different orgs need to attribute costs differently (by team, project, environment, user)  
**Analytics:**
- Cost by agent (agent-level attribution for chargeback)
- Cost by API key (which keys are driving spend?)
- Cost by user metadata (if request includes user ID in metadata/tags)
- Cost by endpoint pattern (chat vs embeddings vs completions)
- Cost by tenant hierarchy (subtenant rollups already exist, but surfacing total vs. per-child is valuable)

**Implementation:** Group by `agent_id`, join to `api_keys` table, extract metadata from `request_body` JSONB.

### 1.2 Cost Forecasting & Budget Alerts
**What:** Projected monthly cost based on current run rate  
**Why:** Prevent bill shock; enable proactive budget management  
**Analytics:**
- Current month spend vs. same period last month (growth rate)
- Projected end-of-month cost (linear extrapolation from daily average)
- Day-over-day and week-over-week cost trends
- Budget burn rate (if budget configured per tenant/agent)

**Implementation:** Simple linear projection: `(total_cost_to_date / days_elapsed) * days_in_month`. Optionally store budget thresholds in tenant settings.

### 1.3 Token Efficiency Metrics
**What:** Token usage patterns that highlight waste or optimization opportunities  
**Why:** High token counts = high costs; identifying inefficiencies saves money  
**Analytics:**
- Average tokens per request by agent (which agents are verbose?)
- Prompt tokens vs completion tokens ratio (are prompts too long?)
- Requests with unusually high token counts (outlier detection: >95th percentile)
- Token usage by time of day (batch workloads vs. interactive)

**Implementation:** Percentile queries on `prompt_tokens`, `completion_tokens`, `total_tokens`. Flag traces where `prompt_tokens` dominates (may indicate overly verbose system prompts).

---

## Priority 2: Performance & Reliability

### 2.1 Error Analytics
**What:** Detailed error breakdowns beyond aggregate error rate  
**Why:** Current `error_rate` is a single number; operators need actionable diagnostics  
**Analytics:**
- Errors by status code (400 vs 429 vs 500 vs 503)
- Errors by model (some models more flaky than others?)
- Errors by provider (provider reliability comparison)
- Error messages clustering (extract common error patterns from `response_body`)
- Time-to-recovery after error spike

**Implementation:** Group by `status_code`, extract error messages from `response_body.error.message`, pattern matching for common errors (rate limits, timeouts, invalid requests).

### 2.2 Latency Distribution & Outliers
**What:** Beyond p95/p99, show full latency distribution and outlier identification  
**Why:** p95/p99 hide the long tail; outliers indicate systemic issues  
**Analytics:**
- Latency histogram buckets (<100ms, 100-500ms, 500ms-1s, 1-5s, >5s)
- Slowest requests (top 10 by latency, with model/provider/agent context)
- Latency by model and provider (comparative performance analysis)
- Latency degradation trends (is performance getting worse over time?)

**Implementation:** Bucket `latency_ms` into ranges, `ORDER BY latency_ms DESC LIMIT 10` for outliers, join to agents/models for context.

### 2.3 Gateway Overhead Analysis
**What:** Deep dive into `gateway_overhead_ms` and `ttfb_ms`  
**Why:** High overhead suggests gateway bottlenecks (auth, MCP routing, encryption)  
**Analytics:**
- Overhead by agent (do certain agents have expensive MCP pipelines?)
- Overhead distribution (histogram)
- Overhead trends over time (is overhead increasing as traffic grows?)
- TTFB by provider (provider comparison for first-byte latency)

**Implementation:** Already have `gateway_overhead_ms` and `ttfb_ms` in traces; aggregate by agent, provider, time window.

### 2.4 Streaming vs Non-Streaming Performance
**What:** Comparative analytics for streaming vs. JSON responses  
**Why:** Streaming has different performance characteristics; users need visibility  
**Analytics:**
- Streaming adoption rate (% of requests with `stream: true`)
- TTFB comparison (streaming should be faster to first token)
- Total latency comparison (streaming may have higher total latency due to buffering)
- Error rate comparison (streaming vs non-streaming)

**Implementation:** Detect streaming via `request_body.stream`, split metrics by this flag.

---

## Priority 3: Usage Patterns & Adoption

### 3.1 Agent Analytics
**What:** Per-agent usage, performance, and cost metrics  
**Why:** Agents are first-class entities; operators need agent-level visibility  
**Analytics:**
- Requests per agent (which agents are most active?)
- Cost per agent (for chargeback to teams)
- Agent error rates (which agents misconfigured?)
- Agent latency comparison
- Agent adoption trends (new agents over time, agent churn)

**Implementation:** Group by `traces.agent_id`, join to `agents` table for metadata.

### 3.2 API Key Analytics
**What:** Per-API-key usage and security monitoring  
**Why:** API keys are access control boundary; need usage tracking and abuse detection  
**Analytics:**
- Requests per API key (which keys are most active?)
- API key activity timeline (first seen, last seen, gaps)
- Anomalous API key behavior (sudden spike in usage, new models/providers)
- Inactive API keys (candidates for rotation/revocation)

**Implementation:** Join traces to `api_keys` via `agent_id`, group by `api_keys.id`. Detect anomalies via stddev from historical mean.

### 3.3 Provider & Model Adoption
**What:** Trends in provider/model usage over time  
**Why:** Understand migration patterns (e.g., GPT-4 → GPT-4o → Claude), provider diversification  
**Analytics:**
- Provider mix over time (are we diversifying away from single provider?)
- Model version adoption curves (how fast do users adopt new models?)
- Provider failover patterns (do users switch providers after errors?)
- Deprecated model usage (flag usage of soon-to-be-retired models)

**Implementation:** Time-series group by `provider` and `model`, track version strings (e.g., `gpt-4-0613` vs `gpt-4-turbo-2024-04-09`).

### 3.4 Endpoint Usage Patterns
**What:** Breakdown by endpoint type (chat, completions, embeddings, etc.)  
**Why:** Different endpoints have different cost/performance profiles  
**Analytics:**
- Requests by endpoint (`/v1/chat/completions` vs `/v1/embeddings`)
- Cost by endpoint (embeddings cheaper but higher volume?)
- Latency by endpoint (embeddings fast, chat slow)

**Implementation:** Group by `endpoint` column.

---

## Priority 4: Operational Intelligence

### 4.1 Rate Limit & Throttling Analytics
**What:** Track rate limit hits and near-misses  
**Why:** Rate limits = degraded UX; need proactive detection  
**Analytics:**
- 429 rate limit errors by provider (which provider throttling most?)
- 429 errors by agent (which agents hitting limits?)
- Requests per minute by tenant (approaching rate limits?)
- Retry patterns (do clients back off properly after 429?)

**Implementation:** Filter `status_code = 429`, extract rate-limit headers from `response_body` if available, calculate requests/min per tenant.

### 4.2 Request Size Analytics
**What:** Distribution of request/response sizes  
**Why:** Large payloads = higher latency, higher cost, potential issues  
**Analytics:**
- Request body size distribution (JSONB size via `pg_column_size`)
- Response body size distribution
- Largest requests/responses (outliers for investigation)
- Correlation between size and latency

**Implementation:** `pg_column_size(request_body)`, `pg_column_size(response_body)`, bucket into ranges.

### 4.3 Tenant Health Scorecards
**What:** Single-number health metric per tenant combining cost, performance, reliability  
**Why:** Executives need "green/yellow/red" dashboard, not raw metrics  
**Analytics:**
- Health score = composite of error_rate (<5% green, 5-10% yellow, >10% red), latency (p95 <2s green), cost trend (growth <20% MoM green)
- Tenant ranking by health score
- Alerts when tenant moves from green to yellow/red

**Implementation:** Weighted scoring function, thresholds configurable per deployment.

### 4.4 MCP Tool Routing Analytics
**What:** Metrics specific to MCP (Model Context Protocol) tool routing  
**Why:** MCP adds latency and complexity; need visibility into tool usage  
**Analytics:**
- Requests with tool calls (% of requests triggering MCP routing)
- MCP round-trip latency (time spent in MCP layer)
- Tool call success rate (did MCP server respond successfully?)
- Most-used MCP tools (which tools invoked most frequently?)

**Implementation:** Parse `request_body.tools` and `response_body.tool_calls`, track MCP-specific latency (if instrumented), extract tool names.

---

## Priority 5: Compliance & Security

### 5.1 Data Retention & Compliance Reporting
**What:** Analytics to support compliance requirements (GDPR, SOC 2, etc.)  
**Why:** Enterprises need audit trails and retention policies  
**Analytics:**
- Trace volume by age (how much data in each monthly partition?)
- Traces eligible for deletion (past retention window)
- Encrypted vs unencrypted traces (if encryption migration in progress)
- PII detection (flag requests with email/phone patterns in `request_body`)

**Implementation:** Query partition metadata, regex scan for PII patterns (email, phone, SSN), track `encryption_key_version`.

### 5.2 Audit Log Analytics
**What:** Admin actions and configuration changes  
**Why:** Security teams need who-did-what visibility  
**Analytics:**
- Agent config changes (who modified provider configs?)
- API key creation/deletion events
- Tenant creation/deletion events
- Failed authentication attempts (if logged)

**Implementation:** Separate audit log table (not in traces), queryable by actor, action, timestamp.

---

## Priority 6: Business Intelligence

### 6.1 Tenant Segmentation & Cohort Analysis
**What:** Group tenants by usage patterns  
**Why:** Product teams need to understand user segments  
**Analytics:**
- Tenant tiers by usage (light: <1K req/mo, medium: 1K-100K, heavy: >100K)
- Cohort retention (% of tenants active each month since signup)
- Tenant growth curves (usage trajectory over first 90 days)
- Churn detection (tenants with declining usage)

**Implementation:** Bucketing by request volume, cohort tracking via tenant `created_at`, month-over-month comparison.

### 6.2 Feature Adoption
**What:** Track usage of specific features (streaming, tool calls, vision, etc.)  
**Why:** Product teams need to know which features resonate  
**Analytics:**
- Streaming adoption rate (% tenants using `stream: true`)
- Vision adoption (requests with image inputs)
- Tool calling adoption (requests with `tools` array)
- Multi-turn conversation depth (requests per `conversation_id`)

**Implementation:** Parse `request_body` for feature flags (stream, tools, image URLs), join to conversations table for turn count.

### 6.3 Revenue Analytics (for SaaS deployments)
**What:** If Loom is monetized, tie usage to revenue  
**Why:** Finance teams need revenue attribution  
**Analytics:**
- Usage-based billing (cost * markup = revenue)
- Revenue by tenant tier
- Revenue growth trends
- Customer lifetime value (LTV) = cumulative revenue per tenant

**Implementation:** Requires pricing tiers in tenant metadata, markup calculation on top of estimated cost.

---

## Implementation Notes

### Data Modeling
- **Pre-aggregated tables:** For expensive queries (e.g., daily rollups), materialize into summary tables refreshed hourly/daily
- **Materialized views:** Postgres supports materialized views for complex aggregations
- **Cube/rollup tables:** Store pre-computed metrics at multiple granularities (hour/day/week/month)

### Query Performance
- **Partition pruning:** All time-windowed queries already benefit from monthly partitions
- **Composite indexes:** Add indexes for common group-by dimensions (agent_id + created_at, provider + model, etc.)
- **Approximate queries:** For very large datasets, use sampling or HyperLogLog for cardinality estimates

### Dashboard Contracts
McManus (frontend) should consume:
- **Summary cards:** Single-metric tiles (total cost, request count, error rate)
- **Time-series charts:** Arrays of {timestamp, value} for line graphs
- **Breakdowns:** Arrays of {dimension, metric} for bar/pie charts
- **Tables:** Paginated arrays for detailed drill-downs

### Extensibility
- **Custom dimensions:** Allow tenants to tag requests with custom metadata (project, environment, user_id) stored in `request_body.metadata` JSONB
- **Custom metrics:** Allow tenants to define custom aggregations (e.g., "cost per active user")

---

## Recommended Phasing

**Phase 1 (Now):** Cost attribution (agent/key), error breakdowns, latency outliers  
**Phase 2:** Forecasting, MCP analytics, API key monitoring  
**Phase 3:** Tenant health scores, cohort analysis, compliance reporting  
**Phase 4:** Custom metrics, advanced BI (revenue, LTV, churn prediction)

---

## Open Questions
1. Should we materialize daily/hourly rollups, or keep all queries real-time?
2. Do we need tenant-configurable custom dimensions (tags/labels)?
3. Should we expose raw trace exports (CSV/Parquet) for external BI tools?
4. Do we need alerting on top of analytics (e.g., email when error rate >10%)?

---

# RAG-Specific Analytics Metrics for Loom Gateway

**Author:** Kobayashi (AI Expert)  
**Date:** 2026-03-01  
**Context:** RAG system metrics observable at the gateway layer during knowledge-base-augmented requests

## Executive Summary

When an agent has a `knowledgeBaseRef`, the Gateway performs: (1) query embedding, (2) similarity search against `kb_chunks`, (3) context injection into system prompt, (4) provider inference. This document defines **raw signals** to capture at each stage and **derived signals** that Redfoot will compute in the analytics pipeline.

### Raw Signals (Captured at Gateway)

**Embedding Performance:**
- `embedding_latency_ms` — time to embed query via EmbeddingAgent
- `embedding_token_count` — token count from tokenizer/API response
- `embedding_model` — model used (e.g., text-embedding-3-small)

**Retrieval Performance:**
- `retrieval_latency_ms` — pgvector similarity search duration
- `chunks_retrieved_count` — number returned (top-K)
- `chunks_requested_k` — configured K parameter
- `retrieval_similarity_scores` — JSONB array of scores [0-1]

**Context Injection:**
- `context_tokens_added` — token count of injected RAG context
- `context_injection_position` — system_prompt | user_message_prefix | assistant_history
- `original_prompt_tokens` — baseline before RAG augmentation

**Chunk Utilization:**
- `chunks_cited_count` — chunks explicitly cited in response (parse for citations)
- `chunk_ids_retrieved` — JSONB array of chunk UUIDs

**Cost Attribution:**
- `rag_overhead_tokens` — extra tokens added by RAG (prompt_tokens - original_prompt_tokens)
- `rag_cost_overhead_usd` — incremental cost due to RAG

**Failure Modes:**
- `rag_stage_failed` — embedding | retrieval | injection | none
- `fallback_to_no_rag` — boolean, true if fallback triggered
- `retrieval_timeout_ms` — configured timeout (null if none)

### Derived Signals (Computed by Redfoot)

**Retrieval Quality:**
- `avg_max_similarity_score` — trend of top-1 scores
- `avg_similarity_variance` — diversity of retrieved chunks
- `chunk_utilization_rate` — chunks_cited / chunks_retrieved (%)
- `kb_exhaustion_rate` — freq where retrieved < K

**Latency Analysis:**
- `rag_overhead_percentage` — RAG time as % of total
- `ttfb_impact_of_rag` — TTFB difference vs non-RAG
- `retrieval_latency_p95` — 95th percentile retrieval time

**Token Economics:**
- `context_overhead_ratio` — tokens_added / original_prompt
- `rag_cost_per_request_avg` — average incremental cost
- `token_utilization_by_kb` — cost per KB artifact

**Reliability:**
- `rag_failure_rate` — freq of failures
- `fallback_rate` — freq of silent degradation
- `retrieval_timeout_rate` — freq of timeouts

### Implementation Strategy

- Add nullable RAG columns to `traces` table (backward compatible)
- Store similarity scores as JSONB arrays (efficient aggregation)
- Pre-compute `rag_overhead_tokens` at capture time (avoids joins)
- Token counting via tiktoken (~0.5ms overhead acceptable)
- Citation parsing deferred if >2ms

### Open Questions

1. Citation format standard (e.g., `[1]`, `[chunk-id]`, markdown footnotes)?
2. Acceptable chunk utilization threshold (proposed: >40%)?
3. Separate `embedding_traces` table vs embedding in traces?
4. Fallback policy: automatic or fail-fast?
5. Top-K recommended range (proposed: 3-10)?

---

# RAG Analytics Recommendations

**Author:** Redfoot (Data Engineer)  
**Date:** 2026-03-01  
**Context:** RAG system implementation (pgvector, artifacts, kb_chunks, deployments)

## Executive Summary

RAG introduces new signals: embedding operations, retrieval quality, KB utilization, artifact lifecycle. Operators need visibility into KB performance; developers need debugging tools for failures and latency.

This document proposes **15 RAG-specific metrics** organized into 5 categories.

### Category 1: Knowledge Base Health

**kb_coverage_ratio:** % of queries with non-empty retrievals  
- Aggregation: (queries with retrieved_chunks > 0) / (total RAG queries)
- Dimensions: per KB, per agent, per tenant, time-series
- Dashboard: KB detail page (tenant), KB health scorecard (ops)

**kb_chunk_utilization:** Distribution of retrieval frequency per chunk  
- Aggregation: Histogram of retrieval counts over 7/30 days
- Dimensions: per KB artifact
- Dashboard: KB detail → "Hot Chunks" tab

**kb_staleness_days:** Days since KB last updated  
- Aggregation: CURRENT_DATE - MAX(artifact.updated_at)
- Dimensions: per KB, per tenant
- Dashboard: KB list, stale KB alert

### Category 2: Retrieval Performance

**rag_retrieval_latency_ms:** Time from embedding start to retrieval completion  
- Aggregation: p50/p95/p99 latencies, bucketed by time
- Dimensions: per KB, per EmbeddingAgent, per tenant, time-series
- Why: p99 > 500ms indicates pgvector index degradation

**rag_overhead_ratio:** RAG latency as % of total request latency  
- Aggregation: AVG(rag_retrieval_latency_ms / total_latency_ms)
- Dimensions: per agent, per KB, time-series
- Healthy: <15%; >30% warrants optimization

**retrieved_chunk_count:** Actual chunks returned vs configured topK  
- Aggregation: Histogram and AVG chunks per query
- Dimensions: per KB, per agent
- Why: Sparse KB or overly specific queries if < topK

### Category 3: Embedding Operations

**embedding_requests_per_second:** QPS to EmbeddingAgents  
- Aggregation: Time-series count by operation type
- Dimensions: per EmbeddingAgent, per tenant, by operation type (query vs weave)
- Why: Identify bottlenecks, scale capacity

**embedding_cost_usd:** Cost of embedding operations  
- Aggregation: SUM(tokens * cost_per_token) by embedder, tenant
- Dimensions: per EmbeddingAgent, per KB, per tenant, time-series
- Why: Hidden cost visibility, forecasting, chargeback

**embedding_error_rate:** % of embedding requests that failed  
- Aggregation: failed / total
- Dimensions: per EmbeddingAgent, per provider, time-series
- Alert: >5% indicates provider issues

### Category 4: Artifact Lifecycle

**artifact_weave_duration_s:** Time to complete `loom weave` operation  
- Aggregation: p50/p95 durations, bucketed by artifact size
- Dimensions: per KB, per EmbeddingAgent, per tenant
- Why: Slow weave (p95 > 60s) indicates chunking inefficiency

**artifact_size_mb:** Size of artifact bundles in storage  
- Aggregation: SUM and histogram of sizes
- Dimensions: per artifact, per tenant, per org
- Why: Large bundles (>100MB) impact performance and costs

**deployment_status_distribution:** Count of deployments by status  
- Aggregation: Count grouped by status (READY/PENDING/FAILED)
- Dimensions: per tenant, per environment, per artifact
- Why: Stuck PENDING/FAILED indicates provisioning issues

### Category 5: RAG Quality Signals

**citation_click_rate:** % of responses where user clicked citations  
- Aggregation: responses_with_clicks / total_rag_responses
- Dimensions: per agent, per KB, time-series
- Why: Proxy for retrieval quality (requires frontend instrumentation)

**rag_relevance_score:** Average pgvector similarity of top-K chunks  
- Aggregation: AVG of top-1 score, histogram of distribution
- Dimensions: per KB, per query, time-series
- Why: Scores <0.6 indicate poor semantic match

**zero_shot_fallback_rate:** % of queries with no chunks retrieved  
- Aggregation: queries_no_chunks / total_rag_queries
- Dimensions: per KB, per agent, time-series
- Alert: >40% indicates KB doesn't cover query space

### Data Contracts: Trace Extensions

Extended `TraceInput` with RAG fields (nullable):
```
knowledgeBaseId?: string;
embeddingAgentId?: string;
ragRetrievalLatencyMs?: number;
embeddingLatencyMs?: number;
vectorSearchLatencyMs?: number;
retrievedChunkCount?: number;
retrievedChunkIds?: string[];
topChunkSimilarity?: number;
avgChunkSimilarity?: number;
```

New tables:
- `embedding_operations` — embedding request logs
- `artifact_operations` — weave/push/deploy tracking
- `chunk_retrievals` (optional) — granular `(trace_id, chunk_id)` pairs

### Aggregation Strategy

**Real-time (24h):** Use partition pruning on traces  
**Pre-aggregated:** Hourly/daily rollups via background job  
**Materialized:** "Hot chunks" summary (top 100) daily  
**Indexes:** `(knowledgeBaseId, created_at)`, `(embeddingAgentId, created_at)`

### Dashboard Placement

**Operator Dashboard (McManus):** New "RAG Analytics" section
- Tiles: RAG requests, overhead, embedding cost, fallback rate
- Charts: latency trends, KB coverage, embedding QPS, deployment status
- Tables: top KBs, slowest retrievals, failures

**Tenant Portal:**
- KB detail → "Analytics" tab (coverage, trends, hot chunks)
- Agent pages → RAG latency breakdown
- New "RAG Performance" page (per-KB trends, cost attribution)

### Implementation Phases

**P0 (Launch):**
1. Extend traces with RAG fields
2. Create `embedding_operations` table
3. Basic RAG tiles in operator dashboard
4. KB coverage ratio in tenant portal

**P1 (2 weeks):**
5. `artifact_operations` table
6. Overhead ratio and embedding cost metrics
7. Pre-aggregated hourly rollups
8. Chunk utilization (hot chunks) in KB detail

**P2 (Scale):**
9. `chunk_retrievals` table for granular analytics
10. Citation click tracking (frontend instrumentation)
11. Advanced quality signals and alerts
12. Tenant-facing "RAG Performance" page

### Open Questions

1. Chunk retrieval granularity: separate table vs JSONB array?
2. Embedding cost calculation: expand provider pricing?
3. Real-time vs batch metrics SLA?
4. Alert thresholds: error >5%? fallback >40%? overhead >30%?
5. Portal vs CLI visibility: `loom analytics <kb-name>` command?

### Success Metrics

- Operators identify underperforming KBs within 30s
- Developers debug RAG latency via trace drill-down
- Finance teams attribute embedding costs per tenant/KB
- Product teams measure KB adoption and request patterns
- SRE detects embedding provider degradation via alerts

---

## 2026-03-01: Arachne Rebrand — User Directive

**By:** Michael Brown (via Copilot)
**What:** The platform is being rebranded from "Loom" to "Arachne". The CLI binary and all platform naming should reflect this: `loom` CLI → `arachne` CLI, `@loom/cli` → `@arachne/cli`, `loom.ai/v0` apiVersion → `arachne.ai/v0`, platform branding throughout docs.
**Why:** User request — captured for team memory.

## 2026-03-01: Arachne Rebrand — Implementation

**By:** Fenster (Backend Dev)
**What:** Rebranded all user-facing product name references from "Loom" to "Arachne" across 21 files. Scope: package.json, src/ comments, portal UI strings, dashboard UI strings, tests, README, RUNNING_LOCALLY.md. Variable/function names (`loomConfig`, etc.) intentionally left untouched.
**Key files:** `package.json`, `src/index.ts` (X-Loom → X-Arachne header), `portal/src/` (AppLayout, LoginPage, SignupPage, LandingPage, TracesPage, ApiKeysPage), `dashboard/src/` (Layout, ApiKeyPrompt), `README.md`, `RUNNING_LOCALLY.md`.

## 2026-03-01: Registry/KB Database Migration

**By:** Fenster (Backend Dev)
**What:** Created `migrations/1000000000015_registry.cjs` — adds pgvector extension, `tenants.org_slug`, `agents.kind`, and 6 new tables: `vector_spaces`, `artifacts`, `artifact_tags`, `kb_chunks` (pgvector 1536-dim + ivfflat index), `deployments`, `embedding_operations`, `artifact_operations`. Also adds 13 RAG-specific columns to `traces`.
**Decisions:** `org_slug` is nullable (backfill deferred); `kb_chunks.embedding` is `vector(1536)` (text-embedding-3-small); ivfflat `lists=100`; `deployments.runtime_token` stored plain TEXT.

## 2026-03-01: Registry Auth Middleware + JWT Scope Extension

**By:** Fenster (Backend Dev)
**What:** Created `src/auth/registryScopes.ts` (scope constants), extended `src/auth/jwtUtils.ts` with `JwtPayload` interface (`scopes`, `orgSlug`), created `src/middleware/registryAuth.ts` (scope-based Fastify preHandler factory), updated `UserManagementService` — all four `signJwt` calls now embed scopes.
**Decisions:** `registryAuth(requiredScope, secret)` takes explicit secret (matches `createBearerAuth` pattern); owner → `TENANT_OWNER_SCOPES`, member → `[]`; `orgSlug: null` until column migration lands. Backward-compatible (additive payload only).

## 2026-03-01: Registry/KB Domain Entities

**By:** Verbal (Domain Model)
**What:** Created five new domain entities using Peter Coad's Color Modeling archetypes — `Artifact` (🟢 Thing), `VectorSpace` (🔵 Catalog-Entry), `KbChunk` (🟢 Thing), `Deployment` (🩷 Moment-Interval), `ArtifactTag` (🔵 Catalog-Entry). Extended `Agent` with `kind: 'inference' | 'embedding'`. `KbChunk.embedding` typed as `number[] | null` with raw SQL for pgvector.

## 2026-03-01: WeaveService — Chunk/Embed/Sign Pipeline

**By:** Fenster (Backend Dev)
**What:** Created `src/services/WeaveService.ts` — full KB pipeline (parse YAML spec, resolve docs, chunk text, embed via OpenAI, compute preprocessing hash, package `.tgz` with HMAC-SHA256). Also handles config-only bundles for Agent/EmbeddingAgent artifacts.
**Decisions:** No new npm deps — custom YAML parser, custom POSIX ustar tar builder, custom ZIP extractor; native `fetch` for embeddings. P0 always uses `SYSTEM_EMBEDDER_*` env vars (DB-based agent resolution deferred). Only OpenAI for P0.

## 2026-03-01: RegistryService

**By:** Fenster (Backend Dev)
**What:** Created `src/services/RegistryService.ts` — push/resolve/list/pull/delete for content-addressed artifacts. `push()` is idempotent (duplicate sha256 re-upserts tag). `ArtifactTag` upsert pattern moves tag pointer atomically. `VectorSpace` created only for KnowledgeBase kind.
**Decisions:** `version` = tag name; sha256 idempotency (no error on duplicate); chunk deletion before artifact (FK safety); tenant scope guard in `resolve()` handles both hydrated and raw entity ref.

## 2026-03-01: ProvisionService

**By:** Fenster (Backend Dev)
**What:** Created `src/services/ProvisionService.ts` — deploy/unprovision/listDeployments. Validates artifact exists and KB has chunks, mints scoped runtime JWT, stores token in `Deployment.runtimeToken`.
**Decisions:** `RUNTIME_JWT_SECRET` with `PORTAL_JWT_SECRET` fallback; runtime tokens are 1-year by design; `randomUUID()` returned as `deploymentId` on early-exit (no persisted row); KB validation uses live `em.count(KbChunk)` not stale `chunkCount`; `unprovision` calls `markFailed('Unprovisioned')` then explicitly nulls `runtimeToken`.

## 2026-03-01: EmbeddingAgentService + System-Embedder Bootstrap

**By:** Fenster (Backend Dev)
**What:** Created `src/services/EmbeddingAgentService.ts` — `resolveEmbedder()` (named agentRef → DB lookup, else env var fallback) and `bootstrapSystemEmbedder()` (upsert system-wide default embedder on gateway startup). Config stored as JSON in existing `systemPrompt` column. Fixed pre-existing `Agent.schema.ts` and `ApiKey.schema.ts` build failures.
**Decisions:** Config in `systemPrompt` (no new columns); upsert with diff-check before flush; startup hook uses `orm.em.fork()` to avoid polluting main EM.

## 2026-03-01: Tenant org_slug

**By:** Fenster (Backend Dev)
**What:** Added `orgSlug` to Tenant entity, schema, DTOs. Created `src/utils/slug.ts` (`generateOrgSlug`, `validateOrgSlug`). Extended `PATCH /v1/portal/settings` to accept and validate `orgSlug`. Auto-generated on tenant creation and invite acceptance. Uniqueness collision strategy: append `-2`, `-3`, etc. on creation; 409 on PATCH collision.
**Decisions:** `provider` made optional in PATCH (avoids duplicate route registration); uniqueness check runs before `em.flush()` (safe — new row not yet visible in DB).

## 2026-03-01: Registry Gateway Routes

**By:** Fenster (Backend Dev)
**What:** Created `src/routes/registry.ts` — 7 Fastify routes covering push (multipart), list, pull, delete, deploy, list-deployments, unprovision. Registered in `src/index.ts`. Added `@fastify/multipart` (^9.4.0) runtime dependency.
**Decisions:** `REGISTRY_JWT_SECRET` → `PORTAL_JWT_SECRET` → dev fallback; `orm.em.fork()` per request; sha256 validated on push if provided; `registryAuth` preHandler per-route for per-scope enforcement.

## 2026-03-01: Portal KB + Deployment Routes

**By:** Fenster (Backend Dev)
**What:** Added 6 routes to `src/routes/portal.ts` — GET/DELETE `/v1/portal/knowledge-bases`, GET/DELETE `/v1/portal/knowledge-bases/:id`, GET/DELETE `/v1/portal/deployments`, GET/DELETE `/v1/portal/deployments/:id`. Live `chunkCount` via `em.count(KbChunk)`. `searchReady: chunkCount > 0` convenience flag.
**Decisions:** `orm.em.fork()` per handler (no signature change needed); `runtimeToken` excluded from responses; `authRequired` (not `ownerRequired`) — consistent with trace/analytics routes.

## 2026-03-01: CLI Package Scaffold — @arachne/cli

**By:** McManus (Frontend/CLI)
**What:** Scaffolded `cli/` package as standalone Node.js CLI. `cli/package.json` (`@arachne/cli`, Commander.js + node-fetch + form-data, ESM, `arachne` bin), `cli/tsconfig.json`, `cli/src/index.ts` (entry point), 4 command stubs (login, weave, push, deploy), `cli/src/config.ts` (read/write `~/.arachne/config.json`, env var fallback). Added `"workspaces": ["cli"]` to root `package.json`.

## 2026-03-01: RAG Retrieval at Inference Time

**By:** Kobayashi (LLM/RAG)
**What:** Implemented end-to-end RAG pipeline at inference time. New `src/rag/retrieval.ts` (`retrieveChunks()` via pgvector cosine similarity, `buildRagContext()` numbered block with citation instruction). `injectRagContext()` export added to `src/agent.ts`. `knowledgeBaseRef` threaded through `TenantContext`. 13 RAG trace fields wired through `tracing.ts` → `Trace.ts` → INSERT SQL. New migration `1000000000016_add-agent-knowledge-base-ref.cjs`.
**Decisions:** Inject BEFORE `applyAgentToRequest` (rag-context prepends agent system prompt); fallback-to-no-RAG on any failure (inference never blocked); topK hardcoded to 5 (configurable later); system embedder default via env vars; knex.raw `?::vector` cast for pgvector.

## 2026-03-01: Resolved Open Questions — Arachne CLI + RAG P0

**By:** Michael Brown (product)
**What:** Three open questions resolved for the P0 sprint:
1. **Org slug** — configurable per tenant; unique; defaults to slugified tenant name; `PATCH /v1/portal/settings` exposes update.
2. **RAG inference scope** — IN SCOPE for P0. Gateway injects top-K chunks at inference time for agents with `knowledgeBaseRef`.
3. **System embedder** — `SYSTEM_EMBEDDER_PROVIDER` / `SYSTEM_EMBEDDER_MODEL` / `SYSTEM_EMBEDDER_API_KEY` env vars as gateway fallback when no explicit embedding agent is configured.

## 2026-03-02: Definition of Done Update

**By:** Michael Brown (via Copilot directive)
**What:** Updated Definition of Done for all user stories:
1. Code coverage for new features must be 80% or above
2. Documentation must be written/updated covering what has changed or been added — both internal (architecture/API docs) and public user-facing docs
**Why:** User request — captured for team memory
**Impact:** All future features must pass Edie's documentation gate before closure; enforces quality bar and knowledge preservation

## 2026-03-02: Docker Compose Architecture Decision

**By:** Fenster (Backend)  
**Date:** 2026-03-02

**What:** Implemented full-stack Docker Compose configuration with multi-stage builds for both gateway (Node.js) and portal (React/nginx).

**Decisions:**
- Gateway: Multi-stage build separates build-time (TypeScript) from runtime (Node.js); includes `migrations/` for startup DB migrations
- Portal: Vite build → static files served by nginx (not Node.js); nginx reverse-proxies `/v1` API calls to gateway service; `try_files $uri $uri/ /index.html` enables client-side routing
- Services: postgres with healthcheck; ollama without healthcheck (startup too slow); gateway depends on postgres (healthy) + ollama (started); portal depends on gateway (started only)
- All dev secrets explicitly commented as placeholders in compose file

**Impact:** `docker compose up` brings full local development stack; portal at http://localhost:5174, gateway API at http://localhost:3000; developers can override env vars via `.env`

## 2026-03-02: Docker Compose Setup Documentation

**By:** Edie (Technical Writer)  
**Date:** 2026-03-02

**What:** Updated `RUNNING_LOCALLY.md` with comprehensive two-path setup guide: (1) Docker Compose (recommended) — full stack with postgres + ollama + gateway + portal, (2) Node.js development — for active development on gateway/portal only.

**Decisions:**
- Docker Compose emphasized as recommended starting point; clear service reference table with ports
- Ollama specifics: model pulling (llama3.2, nomic-embed-text) using `http://ollama:11434` Docker service name
- Production safety: explicit guidance on generating encryption keys and JWT secrets
- RAG support: System Embedder configuration examples for both Ollama and OpenAI
- README.md already has "Getting Started" link to RUNNING_LOCALLY.md — no changes needed

**Impact:** New developers get full stack running in minutes via Docker Compose; development workflow clearly separated for those modifying gateway/portal code

## 2026-03-02: P0 Documentation Organization & Format

**By:** Edie (Technical Writer)

**What:** Created four separate focused documentation files for P0 Registry/RAG/Portal features instead of one mega-doc. Registry API uses table-based format (method, auth, request fields, response, curl). RAG inference docs include both user-visible behavior (citation blocks, graceful degradation) and internal implementation details. Portal guide includes org slug validation as detailed section and separates "Creating a KB" (CLI) from "Viewing KBs" (Portal). System Embedder doc assumes OpenAI as default with future-proofing for custom embedders. All docs include working code examples (curl, YAML, real env vars), not pseudo-code.

**Decisions:**
- Separate docs per audience (API users, system integrators, end users, DevOps) instead of single mega-doc
- Table-based API format for quick field/auth scanning
- 13 RAG trace fields documented as table with type and description for observability
- Org slugs documented with validation rules, valid/invalid examples, and migration warning
- Documented current OpenAI-only implementation with "Custom Embedders (Future)" section showing YAML spec for tenant/agent-level embedders (Phase 2)

**Impact:** Users quickly find relevant doc; reduces support questions; enables SDK generation from API tables; operators understand trace fields for building dashboards; developers understand design for future phases

## 2026-03-02: P0 Coverage Gaps Summary

**By:** Hockney (Tester)

**What:** Documented coverage gaps in P0 modules (RAG, Registry Routes, EmbeddingAgentService, Slug utils) with rationale for each gap and recommendations.

**Gaps acknowledged (low risk):**
- `retrieveChunks` `fallbackToNoRag`: not implemented (throws on embedding failure); test if added in future
- `EmbeddingAgentService.bootstrapAllTenants`: delegates entirely to `bootstrapSystemEmbedder` (fully covered); test if error-isolation logic added
- Registry `POST /v1/registry/push` sha256-match: implicitly covered by main happy-path; low risk
- Registry `GET /v1/registry/pull` Content-Disposition header: requires integration test with real DB; out-of-scope for unit tests
- `EmbeddingAgentService` apiKey fallback: partially covered; low risk (`?? process.env.*` is single expression)
- Multi-tenant isolation for registry routes: delegated to `RegistryService` (fully tested separately); no additional test needed

**Impact:** Team understands why certain paths are not tested; recommendations for future test additions guide coverage expansion

## 2026-02-27: README Repositioning & Developer Docs Split

**By:** Edie (Technical Writer)  
**Date:** 2026-02-27

**What:** Restructured documentation to position Arachne as an **AI runtime + developer toolchain + portable spec**. Rewrote README from 239 lines (mixing product and impl details) to ~55 lines (clean positioning). Extracted all implementation details—database schema, API internals, stack, source layout—into new `docs/developer-guide.md`.

**Changes:**
- README.md (rewritten): ~55 lines, leading with identity trinity; kept "What You Can Build", "Core Capabilities", getting started, CLI overview, docs index; dropped schema, source files, stack tables
- docs/developer-guide.md (new): Absorbs architecture overview, key source files, API extensions, stack, full database schema (12 tables)
- docs/architecture.md (updated): Added "Further Reading" section linking to developer-guide, CLI overview, registry API

**Decisions:**
1. Keep "Core Capabilities" table (runtime features are core positioning)
2. Keep links to all existing docs (CLI, RAG, Portal, Registry, etc.)
3. Ollama explicitly mentioned in provider list
4. Database schema stays **verbatim** in developer guide (no compression)
5. No new docs created—restructuring only

**Why:** README is a product homepage for repo visitors, not an API reference. Developers should understand what Arachne does immediately; implementation details belong in a dedicated developer guide indexed from architecture.

**Impact:** Clearer positioning; reduced cognitive load (~55-line README vs ~240); implementation details discoverable but not blocking first-time users

## 2026-03-02: Modular Terraform + Azure Key Vault for Secret Management

**By:** Kujan (DevOps / Infrastructure Engineer)  
**Status:** Accepted

### Context

The original `terraform/resources.tf` was a single flat file containing all Azure resources. Secrets (DB password, JWT keys, master key) were passed as plain Terraform input variables and stored as inline Container App secrets — not stored in Key Vault.

### Decision

Refactor the Terraform configuration into 4 child modules and introduce Azure Key Vault with a user-assigned managed identity.

**Module split:**
- `modules/observability` — Log Analytics workspace
- `modules/keyvault` — Key Vault, user-assigned identity, access policies, secrets, `random_password`
- `modules/database` — PostgreSQL Flexible Server, pgvector config, firewall rule, database
- `modules/container_apps` — Container App Environment, gateway app, portal app

**Key Vault design:**
- User-assigned managed identity (`azurerm_user_assigned_identity`) is created inside the keyvault module; its resource ID is threaded into Container Apps via `identity_ids`.
- Deployer access policy: Get, Set, Delete, List, Purge, Recover — needed for `terraform apply`.
- App identity access policy: Get only — least-privilege at runtime.
- DB admin password is auto-generated by `random_password` (24 chars, mixed case + numeric + special) — no longer a manual input.

**Container App secrets:**
Gateway secrets now use `key_vault_secret_id` + `identity` on each secret block instead of inline plaintext values. This requires azurerm provider `~> 3.87`.

**Circular dependency resolution:**
The `database_url` connection string depends on both the DB FQDN (from `module.database`) and the DB password (from `module.keyvault`). To avoid a circular reference, `azurerm_key_vault_secret.database_url` is defined as a root-level resource after both modules resolve, with `depends_on = [module.keyvault]`.

### Consequences

- `database_url` and `db_admin_password` are no longer root input variables — consumers must remove them from `terraform.tfvars` / CI secrets.
- `master_key`, `jwt_secret`, `admin_jwt_secret` remain as sensitive input variables (they must be supplied externally; only the DB password is auto-generated).
- azurerm provider minimum version is now `~> 3.87` (was `~> 3.0`).
- Fresh deploys only — no `terraform state mv` required as there is no existing infrastructure.

## 2026-03-02: PostgreSQL Flexible Server now managed by Terraform

**By:** Kujan (DevOps)  
**Status:** Accepted

### Context

The original `resources.tf` contained a placeholder comment deferring PostgreSQL provisioning to a manual step for beta, with Terraform support noted as a v2 goal. This created operational risk: the database connection string had to be injected as a raw variable (`var.database_url`) with no infrastructure-as-code traceability.

### Decision

PostgreSQL Flexible Server is now fully managed in Terraform:

- **Resource:** `azurerm_postgresql_flexible_server.main` — `B_Standard_B1ms` SKU, PostgreSQL 15, 32 GB storage, zone 1
- **Database:** `azurerm_postgresql_flexible_server_database.main` — database named `arachne`, UTF8/en_US.utf8
- **Variable:** `var.db_admin_password` (sensitive) replaces the need to hand-construct a URL externally
- **Output:** `database_url` (sensitive) is now derived from TF-managed FQDN, making it available to other modules or CI pipelines without manual string construction

The existing `var.database_url` variable in `variables.tf` is retained for now as it is still referenced by the gateway Container App secret; a follow-up task should migrate the gateway to use the new `output.database_url` instead.

**Azurerm Backend:**
A remote `backend "azurerm"` block was added to `main.tf`. Values are placeholder defaults that should be overridden at `terraform init` time via `-backend-config` flags. The storage account is intentionally NOT managed by this Terraform config (bootstrap chicken-and-egg); creation instructions are documented in a comment in `main.tf`.

### Consequences

- `terraform init` now requires `-backend-config` or a `backend.hcl` file pointing to real Azure Storage
- `db_admin_password` must be supplied at plan/apply time (e.g., `TF_VAR_db_admin_password` in CI)
- Database changes (e.g., firewall rules, HA) can now be tracked in version control

## 2026-03-02: Test Maintenance — Frontend Content Tests Drift

**From:** Hockney (Tester)  
**Date:** 2026-03-02  
**Triggered by:** LandingPage test failures after UI redesign

### Issue
When LandingPage.tsx was redesigned (new hero headline + new feature card titles), the test assertions still referenced the old copy. This caused 2 test failures that had nothing to do with broken behavior — just stale string matchers.

### Pattern
Any test that asserts on visible UI text strings (`getByText`, `getAllByText`) will silently break when copy changes. This is especially common for:
- Marketing landing pages (frequently redesigned)
- Feature card titles / hero headlines
- CTA button labels

### Recommendation
1. **Use `data-testid` for structural/functional assertions** — e.g., `data-testid="feature-cards"` so tests verify the cards exist, not their exact titles.
2. **Reserve text assertions for contractually stable strings** — error messages, form labels, navigation links. These change less often.
3. **When changing UI copy, search for the old string in `__tests__/`** before merging — a quick `grep -r "old text" portal/src` catches stale tests at PR time.

### Action
McManus (Frontend): Consider adding `data-testid` anchors to LandingPage feature card section and hero heading for future test stability.
# Decision: Exclude Test Files from portal/tsconfig.json

**Date:** 2025-07-14
**Author:** McManus (Frontend Dev)
**Requested by:** Michael Brown

## Context

`docker build -f Dockerfile.portal .` was failing during the `tsc && vite build` step. TypeScript was compiling test files under `src/**/__tests__/` and `src/**/*.test.tsx`, which reference `global` (a Node.js global unavailable in the browser DOM TS lib).

Locally `npm run build` succeeded because Vite handles transpilation itself and doesn't surface these TS errors in the same way. Docker exposes the failure because it runs a clean `tsc` pass first.

## Decision

Added `"exclude"` to `portal/tsconfig.json` to explicitly remove test files from the production TypeScript compilation:

```json
"exclude": ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx"]
```

## Alternatives Considered

1. **Add `@types/node`** — would let `global` compile, but is wrong because production browser code shouldn't have Node types mixed in.
2. **Add a separate `tsconfig.test.json`** — cleaner long-term, but adds complexity for no immediate gain since Vitest already handles its own tsconfig via `viteEnvironment`.
3. **Move test files outside `src/`** — invasive refactor, changes existing test structure for all 635 tests.

## Rationale

The `exclude` approach is the minimal, idiomatic fix. TypeScript docs recommend excluding test files from the app tsconfig when they're not part of the compiled output. This aligns with standard Vite+React+Vitest project conventions.

## Impact

- `portal/tsconfig.json` — one line added
- No changes to test setup, test files, or Vite config
- Docker build now succeeds
- 635 existing tests continue to pass (Vitest uses its own config)

