# Keaton's Project Knowledge

## Project Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**PRD Summary:**
- **Phase 1:** Gateway (Auditability Foundation) — OpenAI-compatible proxy, streaming, trace recording, token/cost/latency tracking, multi-tenant architecture, minimal dashboard
- **Phase 2:** Control (Governance Layer) — A/B testing, prompt versioning, budget controls, RBAC
- **Phase 3:** Runtime (Agent Execution Platform) — Agent execution graphs, tool call tracing, memory logging

**Success Metrics:** All Goal Glowup traffic routed through Loom, stable streaming performance, trace capture completeness, gateway overhead under 20ms, at least one external beta deployment

**Strategic Positioning:** Loom is the runtime control plane that brings order, auditability, and governance to AI systems in production — NOT a logging tool or dashboard.

## Learnings

### Architecture Decisions (2026-02-24)

**Gateway Layer:**
- Fastify as HTTP framework (fastest mainstream Node.js framework, plugin architecture fits phased roadmap)
- undici for upstream HTTP calls (built-in, connection pooling, fastest option)
- Single Fastify process hosts both gateway (/v1/*) and dashboard API (/api/*) for Phase 1

**Streaming:**
- Node.js Transform stream to tee SSE responses — one leg to client, one to trace recorder
- Lightweight SSE parser extracts data lines, accumulates tokens
- Trace created at request start, finalized on stream completion with accumulated response
- No per-chunk database writes — accumulate in memory, write once

**Trace Schema:**
- Core fields: id, tenant_id, request_id, model, provider, endpoint, request_body (JSONB), response_body (JSONB), status_code, latency_ms, ttfb_ms, gateway_overhead_ms, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, is_streaming, chunk_count, api_key_id, ip_address, error (JSONB)
- JSONB for request/response bodies — flexible and queryable
- Never store raw API keys in traces — only api_key_id references

**Multi-Tenant:**
- API-key-based tenancy (Loom issues keys in format: loom_sk_{prefix}_{random})
- Shared database with tenant_id column on all tables
- In-memory LRU cache for API key → tenant resolution (60s TTL)
- PostgreSQL Row-Level Security available for Phase 2 if needed

**Database:**
- PostgreSQL for Phase 1 (sufficient for expected volume, JSONB support, mature ecosystem)
- Traces table partitioned by month
- ClickHouse considered as analytics sidecar for Phase 3 if needed

**Performance (<20ms overhead):**
- Estimated sync overhead: 3-6ms (parsing ~1ms, tenant lookup ~1-3ms cached, stream tee ~1-2ms)
- Trace persistence is async (fire-and-forget, off hot path)
- Connection pooling: undici pool for upstream, pg pool for database
- gateway_overhead_ms measured on every request as canary metric

**Dashboard API:**
- REST (not GraphQL) — predictable query patterns, simpler caching
- Endpoints: GET /api/traces, GET /api/traces/:id, GET /api/analytics/summary, GET /api/analytics/timeseries
- Cursor-based pagination for trace lists

**Open Questions (awaiting Michael's input):**
- Multi-provider support in Phase 1? (OpenAI only vs. Azure/Anthropic)
- Full request/response body storage vs. configurable retention
- Co-located gateway + dashboard vs. separate services
- Expected request volume through Goal Glowup

### Open Questions Resolved (2026-02-24)

Michael Brown confirmed:
1. **Multi-provider Phase 1:** Azure OpenAI + OpenAI (Azure for free tokens during testing)
2. **Full body storage:** Yes, store complete request/response bodies by default — no truncation
3. **Service topology:** Single process acceptable for Phase 1
4. **Volume target:** 1,000 req/sec capacity (~86M traces/day)

Key design implications from volume target:
- Batch inserts required for trace persistence (not individual INSERTs)
- Write queue in memory with flush interval (100ms or 100 traces)
- Monthly partitioning essential for query performance
- pg pool sizing: 20-30 connections for write throughput

### Provider Abstraction Pattern
- Common provider interface with `forwardRequest()` and `forwardStreamingRequest()` methods
- OpenAI adapter: standard base URL, bearer token auth
- Azure OpenAI adapter: resource-based URL pattern (`{resource}.openai.azure.com/openai/deployments/{deployment}`), api-key header, api-version query param
- Provider resolved per-tenant via configuration

### Work Decomposition (2026-02-24)
- 10 backend items (Fenster): F1-F10
- 5 frontend items (McManus): M1-M5
- 7 test items (Hockney): H1-H7
- Critical path: F1 → F4 → F6 → F7 → H6
- 4 execution waves identified for parallel work

### Security Architecture (2026-02-24)

**Tenant Data Encryption Decision:**
- Use encryption-at-rest for all tenant data (request_body, response_body columns in traces table)
- Application-level column encryption using AES-256-GCM (authenticated encryption)
- Envelope encryption pattern: master key + tenant_id derives per-tenant DEKs
- Threat model: Unauthorized database console access (compromised admin, insider threat)
- ETL workaround deferred — dashboard lag acceptable for Phase 1 observability use case

**Key Management Strategy:**
- Phase 1: Master key in environment variable, deterministic tenant key derivation
- Phase 2: External KMS (AWS KMS), key rotation with grace period
- Schema includes encryption_key_version column now to avoid backfill migration later

**Implementation Pattern:**
- Encrypt at trace persistence (off hot path, no gateway latency impact)
- Decrypt on dashboard API reads (~0.01ms per trace, negligible for human-scale UI)
- Store IV (initialization vector) in separate columns (request_iv, response_iv)
- Tenant isolation: one tenant's key compromise doesn't expose others

**Performance Impact:**
- Encryption overhead: <0.01ms per trace (unmeasurable at 1000 req/sec)
- Dashboard analytics lag: ~10ms for 1000-trace page (acceptable for observability)

**Alternatives Rejected:**
- PostgreSQL TDE: Too coarse-grained, limited key rotation
- No encryption: Fails to address unauthorized DB console access threat
- Selective encryption: Too complex to determine what's sensitive in prompts

### Schema Changes (2026-02-24)
- Added `encryption_key_version` column to traces table migration (1000000000003_create-traces.cjs)
- Column spec: `integer NOT NULL DEFAULT 1`
- Purpose: Phase 2 key rotation support, avoids backfill migration later
- Migration follows envelope encryption pattern from security architecture decision

### Key File Paths
- PRD: /Users/michaelbrown/projects/loom/Loom_PRD_v0.1.pdf
- Team decisions: /Users/michaelbrown/projects/loom/.squad/decisions.md
- Architecture proposal (original): /Users/michaelbrown/projects/loom/.squad/decisions/inbox/keaton-architecture-proposal.md
- Architecture decision (approved): /Users/michaelbrown/projects/loom/.squad/decisions/inbox/keaton-architecture-approved.md
- Security architecture (encryption): /Users/michaelbrown/projects/loom/.squad/decisions/inbox/keaton-tenant-encryption.md
- Database migrations: /Users/michaelbrown/projects/loom/migrations/

## 2026-02-24T03:31:15Z: Wave 1 Encryption Launch Spawn

**Event:** Spawned for encryption infrastructure Phase 1  
**Task:** Add encryption_key_version column to traces migration  
**Mode:** Sync  
**Coordination:** Part of 4-agent wave (Keaton sync, Fenster/McManus/Hockney background)

## 2026-02-24T04:00:00Z: GitHub Issues Migration — Work Breakdown to Issues

**Task:** Migrate approved architecture work items to GitHub issues for team visibility  
**Outcome:** Created 17 GitHub issues (6 Backend/Fenster, 5 Frontend/McManus, 6 Testing/Hockney)

### Issues Created

**Backend (Fenster) — 6 items:**
- F3: Tenant Auth Middleware (Wave 2)
- F5: Azure OpenAI Adapter (Wave 2)
- F6: SSE Streaming Proxy (Wave 2)
- F7: Trace Recording & Persistence (Wave 3)
- F8: Analytics Engine (Wave 3)
- F9: Dashboard API Endpoints (Wave 3)
- F10: Provider Configuration & Tenant Routing (Wave 3)

**Frontend (McManus) — 5 items:**
- M2: Traces Table Component (Wave 3)
- M3: Trace Details Panel (Wave 3)
- M4: Analytics Summary Card (Wave 3)
- M5: Analytics Timeseries Charts (Wave 3)

**Testing (Hockney) — 6 items:**
- H2: Proxy Correctness Tests (Wave 2)
- H3: Authentication Tests (Wave 2)
- H4: Multi-Tenant Isolation Tests (Wave 3)
- H5: Multi-Provider Tests (Wave 2)
- H6: Streaming & Trace Recording Tests (Wave 3)
- H7: Encryption-at-Rest Tests (Wave 3)

### Issue Structure

Each issue includes:
- Clear acceptance criteria (what "done" means)
- Dependencies (blocks/blocked-by relationships)
- Performance targets where applicable
- Reference to architecture decisions in .squad/decisions.md
- Labels for squad assignment (squad:fenster, squad:mcmanus, squad:hockney)
- Wave assignment for execution planning (Wave 2 parallel work, Wave 3+ follow-on)

### Repository Details

- **Repository:** Goalglowup/loom on GitHub
- **Issues Platform:** GitHub Issues (not Jira)
- **Labels System:** squad:* (agent assignment), wave:* (execution phase)
- **Total Work Items in Phase 1:** 22 (5 completed in Wave 1, 17 remaining)

### Lessons Learned

1. **GitHub Labels Required Setup:** Had to create custom labels before bulk issue creation (squad:fenster, squad:mcmanus, squad:hockney, wave:2, wave:3)
2. **Wave 2 Critical Path:** F3 → F6 → F7 (tenant auth → streaming → trace recording) must execute sequentially; H2/H3/H5 can run in parallel with F3-F6
3. **Wave 3 Unblocking:** F7 and F8 are the critical unlocks for all frontend work (M2-M5) and remaining test coverage (H4, H6, H7)
4. **Architecture Decisions Embedded:** Each issue references specific decisions from .squad/decisions.md to ensure team alignment; no decisions isolated in issue comments

### Multi-Tenant Management Design (2026-02-25)

**Task:** Design multi-tenant management feature — tenant CRUD, API key management, provider config management, dashboard admin view.

**Key Design Decisions:**
1. **Admin auth via `ADMIN_API_KEY` env var** — avoids RBAC complexity in Phase 1. Single shared admin key checked in a dedicated preHandler hook on `/v1/admin/*` routes.
2. **Schema additions, not replacements** — two ALTER TABLE migrations add `status`/`updated_at` to tenants and `name`/`key_prefix`/`status`/`revoked_at` to api_keys. All new columns have defaults for backward compatibility with existing data.
3. **Soft deactivation over hard delete** — tenants get `active`/`inactive` status; API keys get `active`/`revoked`. No cascade deletes in management operations.
4. **Auth query tightened** — existing `lookupTenant` query must filter by `ak.status = 'active' AND t.status = 'active'`. LRU cache invalidation helpers exported for use by admin routes.
5. **Dedicated Admin page, not tenant switcher** — dashboard stays per-tenant for operators; new `/admin` route for Loom operator with separate admin API key in localStorage. Avoids mixing operator and tenant concerns.
6. **Provider config management with cache eviction** — PUT/DELETE on provider config calls `evictProvider(tenantId)` to force re-init on next request. Already supported by registry.ts.

**Work Breakdown:** 8 backend tasks (Fenster), 6 frontend tasks (McManus), 5 test tasks (Hockney). 4 execution waves. Critical path: schema → auth update → CRUD endpoints → route registration.

**Open Questions for Michael:** Admin auth model sufficiency, hard delete vs. soft deactivation, provider config secret encryption, existing data backfill approach.

**Design doc:** `.squad/decisions/inbox/keaton-multitenant-design.md`

### Multi-Tenant Design Revision (2026-02-25)

**Task:** Revise multi-tenant management design based on Michael Brown's answers to 4 open questions.

**Decisions Incorporated:**
1. **Q1 — Admin auth:** Changed from shared `ADMIN_API_KEY` env var to per-user admin auth. New `admin_users` table with bcrypt password hashing + JWT-based login endpoint (`POST /v1/admin/login`). `ADMIN_JWT_SECRET` env var for token signing. Keeps it simple (no RBAC) but eliminates shared secrets.
2. **Q2 — Deletion:** Soft delete remains default (`PATCH` with `status: "inactive"`). Added hard `DELETE /v1/admin/tenants/:id?confirm=true` with cascade (api_keys → traces → provider_config → tenant row). API keys get `?permanent=true` option on DELETE. Confirmation guards prevent accidents.
3. **Q3 — Provider config encryption:** Provider API keys encrypted at rest using existing AES-256-GCM pattern from `src/encryption.ts`. Same `ENCRYPTION_MASTER_KEY` + per-tenant HMAC-SHA256 key derivation. Encrypt on write, decrypt on read in `registry.ts`. API responses show `hasApiKey: boolean` only.
4. **Q4 — Existing data backfill:** Confirmed Keaton's recommendation — migration defaults handle it. No change needed.

**Work Breakdown Impact:**
- F-MT4 split into F-MT4a (admin_users migration) and F-MT4b (admin login endpoint + JWT middleware + seed script)
- F-MT5 updated to include hard DELETE with cascade
- F-MT6 updated to include `?permanent=true` hard delete for API keys
- F-MT7 updated to include AES-256-GCM encryption/decryption of provider API keys
- H-MT1 expanded to cover JWT auth testing (login, validation, expiry)
- Critical path shifted to F-MT4a → F-MT4b → F-MT5 → F-MT8
- Wave structure preserved (4 waves), task count increased slightly

**Key Lesson:** Per-user admin auth with JWT is the right call for Phase 1 — it's barely more complex than a shared env var but eliminates the "who did this?" blindspot and prepares the path for Phase 2 RBAC. Bcrypt is fine for admin login because it's not on the gateway hot path.

## 2026-02-25T10:20:10Z: Multi-Tenant Wave A Design Finalization

**Event:** Final multi-tenant design document approved and merged to decisions.md  
**Status:** ✅ Complete, ready for implementation wave execution

**What was finalized:**

1. **Complete Design Document** — Full API surface, schema migrations, auth patterns, work breakdown, risk analysis documented in `.squad/decisions.md`
2. **Michael's Q&A Incorporated** — All 4 open questions answered and design revised accordingly
3. **Implementation Ready** — Backend (Fenster), frontend (McManus), and testing (Hockney) work breakdown finalized across 4 waves

**Design Highlights:**

- **Multi-tenant model:** API key-based tenancy with per-tenant provider config, status lifecycle
- **Admin interface:** Per-user JWT auth (not shared secret), dedicated `/admin` route/page, separate from operator tenant interface
- **Lifecycle management:** Soft deactivation (status: inactive) + hard delete with confirmation guards (`?confirm=true`, `?permanent=true`)
- **Security:** Provider API keys encrypted at rest (reuses existing AES-256-GCM infrastructure)
- **API coverage:** 11 admin endpoints across tenant CRUD, API key management, provider config management
- **Database:** 3 migrations (F-MT1, F-MT2, F-MT4a) adding status/lifecycle columns and admin_users table

**Work Breakdown:**
- **Backend:** 8 tasks (Fenster) F-MT1 through F-MT8
- **Frontend:** 6 tasks (McManus) M-MT1 through M-MT6
- **Testing:** 5 tasks (Hockney) H-MT1 through H-MT5
- **Critical path:** F-MT4a → F-MT4b → F-MT5 → F-MT8
- **Execution:** 4 waves (A through D)

**Risks Identified (managed):**
- LRU cache invalidation on key revocation (ID→hash lookup required, design documented)
- Admin routes share Fastify instance (acceptable Phase 1, note for Phase 2 service split)
- Hard delete cascade on large tenants (sync delete acceptable for expected volumes)
- JWT secret management (must be set at startup, fail loudly if missing)

**Deferred to Phase 2:** RBAC per admin user, tenant self-service registration, audit logging, rate limiting per tenant, multi-region routing

**Cross-Team Context:** Fenster implemented Wave A (migrations F-MT1, F-MT2 + startup check). Migrations provide schema foundation. Future waves unlock endpoint development (Wave B), admin UI (Waves C/D), and test coverage.

### Tenant Self-Service Portal Architecture (2025-07-24)

**Request:** Michael Brown asked for a tenant self-service portal — landing page at root, signup/login, and a UI for managing gateway settings (LLM provider config, API keys).

**Decision:** Full architecture spec written to `.squad/decisions/inbox/keaton-tenant-portal-architecture.md`.

**Key decisions:**
- Separate Vite+React app in `portal/` (not extending dashboard — different audience, different auth)
- New `tenant_users` table (email, password_hash, tenant_id, role). Email globally unique. Scrypt hashing.
- Portal API at `/v1/portal/*` with its own JWT (`PORTAL_JWT_SECRET`, separate from admin JWT)
- Dual `@fastify/jwt` registration using `namespace`/`decoratorName` to isolate admin vs portal tokens
- Signup creates tenant + owner user + auto-generated API key in a single transaction
- Portal static files served at `/` with SPA fallback for non-API, non-dashboard routes
- Provider config management reuses existing encryption (`ENCRYPTION_MASTER_KEY`) and cache eviction patterns
- Auth skip list in `src/auth.ts` updated to bypass API key auth for `/v1/portal/*` routes

**Gotchas flagged:**
- `@fastify/static` decorator collision (need `decorateReply: false` on second registration)
- SPA fallback ordering (must not catch `/v1/*` 404s as HTML)
- Email uniqueness = one user per tenant (simple now, junction table refactor if multi-tenant-per-user needed later)
- Rate limiting on signup/login deferred but noted as TODO

### Multi-User Multi-Tenant Architecture (2026-02-26)

**Request:** Michael Brown asked for multiple users per org/tenant via invite links, and users belonging to multiple tenants.

**Key Architecture Decisions:**

1. **Separate identity from membership:** Split `tenant_users` into `users` (auth identity, email UNIQUE) + `tenant_memberships` (junction table, UNIQUE(user_id, tenant_id)). This is the junction table refactor noted as a future possibility in the portal architecture.

2. **Keep tenantId in JWT:** Existing JWT payload `{ sub, tenantId, role }` stays identical. This means zero changes to `portalAuth.ts` middleware and zero changes to any existing route handler. Multi-tenant switching works by issuing a new JWT via `POST /v1/portal/auth/switch-tenant`.

3. **Invite token model:** New `invites` table with 256-bit random tokens, optional max_uses, configurable expiry (default 7 days), soft revocation. Invite URL format: `{PORTAL_BASE_URL}/signup?invite={token}`.

4. **Two roles only:** `owner` (full access) and `member` (read-only traces/analytics). Maps to existing `ownerRequired` vs `authRequired` preHandler pattern.

5. **Signup dual-path:** `POST /v1/portal/auth/signup` accepts optional `inviteToken`. Without invite: existing flow (creates tenant + user + API key). With invite: creates/links user, adds membership as `member`, no API key generated.

6. **Migration strategy:** Single migration (1000000000011) creates `users` + `tenant_memberships` tables, migrates data from `tenant_users`, creates `invites` table, drops `tenant_users`. Existing users preserve their IDs and become owners of their current tenant.

**Work Breakdown:** 7 backend (Fenster), 6 frontend (McManus), 5 testing (Hockney). 4 execution waves. Critical path: F-MU1 → F-MU3+F-MU4 → M-MU2+M-MU6.

**Risk Notes:**
- JWT tenantId can go stale after member removal (24h expiry window) — mitigated by membership checks on sensitive operations
- Last-owner race condition on concurrent demotion — requires SELECT FOR UPDATE
- Migration rollback is lossy for users with multiple memberships (known limitation)

**Design doc:** `.squad/decisions/inbox/keaton-multi-user-tenant-arch.md`

---

## 2026-02-27: Multi-User Multi-Tenant Architecture (Approved, Implemented)

**Status:** Spec complete, backend & frontend implemented, awaiting testing

**Scope:** Designed comprehensive architecture for multiple users per tenant, tenant invites, and tenant switching.

**Deliverable:** `.squad/decisions.md` merged from inbox (keaton-multi-user-tenant-arch.md)

**Implementation Status:**
- Backend (Fenster): 13 endpoints + migration ✓
- Frontend (McManus): AuthContext, TenantSwitcher, MembersPage, SignupPage updates ✓
- Testing (Hockney): Awaiting test suite execution

**Critical Path Completed:** F-MU1 (migration) → F-MU3, F-MU4 (auth) → M-MU2, M-MU6 (switcher + state)

**Deferred to Phase 2:**
- Email notifications, invite role customization, tenant transfer, user profile mgmt, rate limiting, audit logging, last-owner race condition fix

## 2026-02-27: README & Documentation Rewrite (Comprehensive)

**Task:** Rewrite README.md as product-facing documentation, move dev setup to RUNNING_LOCALLY.md

**Learnings from Code Audit:**

1. **Gateway Core:** `/v1/chat/completions` is the main proxy endpoint. Extensions added: `conversation_id` (optional), `partition_id` (optional) for conversation memory. Response echoes these IDs.

2. **Multi-Tenant Model:** API key authentication → tenant lookup via cached key_hash → strict data isolation. Each tenant has optional `provider_config` (OpenAI/Azure), optional agents (system prompt, skills, MCP endpoints).

3. **Agent System:** Agents have `merge_policies` controlling how system_prompt/skills/mcp_endpoints blend with user requests. `applyAgentToRequest()` does injection with three strategies per field (prepend/append/overwrite/ignore). One-shot MCP round-trip supported.

4. **Conversation Memory:** Optional per-agent feature (flag: `conversations_enabled`). Supports partitioning (e.g., by document/session). Persistent messages (encrypted). Auto-summarization when token budget exceeded. Context injection prepends latest snapshot + unsummarized messages to request.

5. **Trace Recording:** Batched async flushing (100 traces or 5 seconds). Encryption at rest (AES-256-GCM). Request/response/latency/tokens/overhead recorded. Partitioned by month. All bodies encrypted with per-tenant derived keys.

6. **Analytics:** Token counts, latency percentiles (p95/p99), error rates, cost estimation (per-model rates), gateway overhead, TTFB. Subtenant rollup via recursive CTE. Timeseries bucketing configurable.

7. **Portal Routes:** `/v1/portal/*` handles tenant signup, login, tenant switching (multi-user, multi-tenant). Invite links with max_uses and expiry. JWT auth (separate from admin JWT, `PORTAL_JWT_SECRET`).

8. **Admin Routes:** `/v1/admin/*` requires admin JWT auth. CRUD for tenants, API keys, provider config. System-wide analytics. Audit trail queries.

9. **Database Schema:** 12 core tables (tenants, agents, api_keys, traces, conversations, partitions, conversation_messages, conversation_snapshots, users, tenant_memberships, invites, admin_users). Traces partitioned monthly. All conversation content encrypted at rest.

10. **Provider Pattern:** Registry (factory pattern) resolves provider per-tenant. OpenAI & Azure adapters with different URL/auth patterns. Provider eviction on config change to force re-init.

**Deliverables:**
- NEW: `RUNNING_LOCALLY.md` — All setup/dev content from old README
- UPDATED: `README.md` — Product-focused with full capability descriptions, architecture overview, API extensions, and comprehensive database schema

**Documentation Strategy:** Lean, bullet-point heavy, developer audience. No marketing fluff. Accurate reflection of what the codebase actually does.

## 2026-02-27: Legacy Service Audit — PortalService & AdminService vs Domain Layer

**Task:** Comprehensive audit comparing legacy services (PortalService, AdminService) against domain-layer services (UserManagementService, TenantManagementService, TenantService) to identify ALL custom logic in legacy that is missing from domain.

**Key Findings:**

1. **Critical Infrastructure Gaps (13 must-fix issues):**
   - **Default agent creation on signup:** PortalService creates a "Default" agent during tenant signup transaction. UserManagementService does NOT. Without this, subsequent API key creation fails (keys require an agent).
   - **Cache invalidation after API key revocation:** PortalService returns `key_hash` and route calls `invalidateCachedKey(keyHash)`. Domain layer does NOT. Revoked keys remain cached and usable for up to 60 seconds.
   - **Provider cache eviction after config updates:** PortalService calls `evictProvider(tenantId)` after updating provider config. Domain layer does NOT. Updated config won't take effect until cache expires.
   - **Subtenant creator membership:** PortalService creates owner membership for subtenant creator. Tenant.createSubtenant does NOT. Subtenant is orphaned (no members).
   - **Invite revocation:** PortalService has `revokeInvite`. Domain layer does not.
   - **Member role updates:** PortalService has `updateMemberRole` with last-owner protection (prevents demoting last owner). Domain layer does not.
   - **Member removal:** PortalService has `removeMember` with last-owner protection and self-removal check. Domain layer does not.
   - **Leave tenant:** PortalService has `leaveTenant` with active-tenant check and last-owner protection. Domain layer does not.
   - **Tenant switching:** PortalService has `switchTenant` (validates membership, checks tenant status, re-signs JWT). Domain layer has NONE. Entire multi-tenant switching flow missing.
   - **Login: active tenant filtering:** PortalService filters by `t.status = 'active'` in multi-tenant list. UserManagementService does NOT. Returns inactive tenants.
   - **Login: multi-tenant list:** PortalService returns `tenants: [{id, name, role}, ...]` for tenant switcher. UserManagementService returns only primary tenant.
   - **Invite acceptance: tenant status check:** PortalService validates `t.status = 'active'` in invite query. UserManagementService does NOT. Can accept invite for inactive tenant.
   - **Invite acceptance: duplicate membership error:** PortalService throws 409 if already a member. UserManagementService silently skips membership creation (no error).

2. **Feature Parity Gaps (7 nice-to-have issues):**
   - **Profile/dashboard bootstrap:** PortalService has `getMe` (composite query: user + role + tenant + provider config + agents + subtenants + all tenants). Domain layer has NONE.
   - **Resolved agent view:** PortalService has `getAgentResolved` (recursive CTE walks parent chain, resolves inherited config). Domain layer has NONE.
   - **Conversation/partition management:** PortalService has full CRUD for conversations and partitions. Domain layer has ZERO conversation management.
   - **Admin tenant management:** AdminService has admin-level tenant CRUD (create without users, hard delete, list with filters). Domain layer has NONE.
   - **Agent cache eviction:** PortalService does NOT call `evictProvider` after agent updates. Neither does domain layer. Shared gap: agent config changes don't invalidate cache.
   - **Email uniqueness check with 409:** PortalService pre-checks email and throws 409. UserManagementService relies on DB constraint (generic error).
   - **Tenant name trimming:** PortalService trims tenant name. UserManagementService uses raw `dto.tenantName`.

3. **Password Hashing & JWT Signing:**
   - Both PortalService and UserManagementService use **scrypt** with same pattern (16-byte salt, 64-byte derived key, `salt:key` format).
   - Both use **fast-jwt** with same secret (`PORTAL_JWT_SECRET`), same expiry (24h), same payload (`{ sub, tenantId, role }`).
   - AdminService uses scrypt for admin users (isolated from portal auth).
   - **No gap** — domain layer has password hashing and JWT signing.

4. **Architecture Pattern Differences:**
   - **PortalService:** Raw SQL via Knex (`rawQuery()` helper). Explicit transactions. Manual JSONB serialization.
   - **Domain Services:** ORM (MikroORM) with entities. EntityManager flush (implicit transactions). Auto JSONB handling.
   - **Cache helpers:** Both legacy services import `invalidateCachedKey` and `evictProvider` from `src/auth.ts` and `src/providers/registry.ts`. Domain services do NOT import or call these.

5. **Business Rules in Legacy Services:**
   - **Last-owner protection:** PortalService checks owner count before demotion/removal/leave (`SELECT COUNT(*) ... WHERE role = 'owner'`). Prevents leaving/removing last owner. Domain layer has NONE.
   - **Self-removal check:** PortalService prevents self-removal via `removeMember` ("use leave instead"). Domain layer has NONE.
   - **Active tenant check on leave:** PortalService prevents leaving currently active tenant. Domain layer has NONE.
   - **Active tenant filtering:** PortalService filters inactive tenants in login response and tenant lists. Domain layer does NOT.

6. **Side Effects Missing from Domain Layer:**
   - **Cache invalidation:** After API key revocation, provider config updates, tenant deactivation.
   - **Provider eviction:** After provider config updates, tenant deletion.
   - **Default agent creation:** On tenant signup.
   - **Membership creation:** On subtenant creation.

**Deliverable:** `.squad/decisions/inbox/keaton-portal-service-audit.md` — 20+ gap items categorized by complexity, with recommendations for 2-sprint migration strategy.

**Migration Recommendation:** Enhance domain services (Option A) over 2 sprints:
- **Sprint 1:** Fix 13 must-fix issues (blocking functionality, security gaps). Estimated: 3-5 days.
- **Sprint 2:** Feature parity (7 nice-to-have). Estimated: 5-7 days.

**Key Insight:** Domain layer is structurally sound (ORM, entities, clean patterns) but missing **critical infrastructure** (cache invalidation, default data creation, business rules) and **entire features** (tenant switching, member management, conversation CRUD). Legacy services are production-proven but use raw SQL and lack domain modeling. Path forward: backport infrastructure and features into domain layer, then deprecate legacy services.

### Architecture Document Created (2026-02-27)

**Task:** Created comprehensive architecture document at `docs/architecture.md`.

**Key architectural facts captured:**
1. **Single Fastify process** serves gateway, portal API, dashboard API, admin API, and two static SPAs (portal at `/`, dashboard at `/dashboard`)
2. **Two persistence strategies coexist** — legacy services (PortalService, AdminService) use raw SQL via Knex; domain services use MikroORM entities. Migration in progress.
3. **Three auth domains** — Gateway (API key + LRU cache), Portal (fast-jwt), Admin (@fastify/jwt). Each has its own secret and middleware.
4. **Trace recorder** is a singleton with batched async flush (100 rows / 5s). Fire-and-forget from the hot path.
5. **Analytics computed on-read** from traces table via raw SQL — no materialized views or pre-aggregation.
6. **Encryption** uses AES-256-GCM with HMAC-SHA256 per-tenant key derivation from a master key. Applied to traces, conversations, snapshots, and provider API keys.
7. **Provider abstraction** — BaseProvider → OpenAI/Azure adapters with lazy-cached instances per agent. Ollama supported via OpenAI adapter with custom baseUrl.
8. **14 migrations** (CommonJS), traces partitioned by month, 12 core entities.
9. **Subtenant hierarchy** via `parent_id` self-FK with recursive CTE resolution for inherited config.

**Deliverables:**
- `docs/architecture.md` — 13-section architecture reference with Mermaid diagrams
- `README.md` — Updated Architecture section to link to the full doc

## GitHub Issue Backlog Created (2026-02-27)

Created full GitHub issue backlog at Goalglowup/loom with 10 epics and 27 stories.

### Epic Issue Numbers
- Epic 1: [Admin Dashboard] — #18
- Epic 2: [Cost Management & Attribution] — #19
- Epic 3: [Error & Reliability Analytics] — #20
- Epic 4: [Agent & API Key Analytics] — #21
- Epic 5: [Security & Compliance] — #22
- Epic 6: [Streaming & MCP Phase 2] — #23
- Epic 7: [Developer Experience] — #24
- Epic 8: [Multi-Tenant Management] — #25
- Epic 9: [Conversation Management UX] — #26
- Epic 10: [Provider Management] — #27

### Story Issue Numbers
- #28 1.1 Admin can log in via a web UI
- #29 1.2 Admin can view and manage tenants
- #30 1.3 Admin can view system-wide analytics
- #31 2.1 Tenant operator can see costs broken down by agent
- #32 2.2 Tenant operator can forecast monthly LLM spend
- #33 2.3 Tenant operator receives budget alerts when spend exceeds threshold
- #34 2.4 Tenant operator can see token efficiency metrics
- #35 3.1 Developer can see errors broken down by type
- #36 3.2 Operator can see latency distributions and slowest requests
- #37 3.3 Operator can track rate limit events by provider
- #38 4.1 Tenant operator can see per-agent usage and cost analytics
- #39 4.2 Security admin can monitor API key usage and identify anomalies
- #40 5.1 Compliance officer can view an audit log of configuration changes
- #41 5.2 Security admin can set API key expiry and rotate keys
- #42 5.3 Compliance officer can see traces flagged for potential PII
- #43 6.1 Agent developer can use MCP tool routing with streaming responses
- #44 6.2 Operator can see analytics on MCP tool invocations
- #45 7.1 Developer can see token count and cost for each sandbox request
- #46 7.2 Developer can test multi-turn conversations in the sandbox
- #47 7.3 New user sees helpful empty states and onboarding guidance
- #48 8.1 Parent tenant operator can see health scorecards for all subtenants
- #49 8.2 Parent tenant operator can delegate management to subtenant admins
- #50 9.1 Tenant member can browse and search conversation history
- #51 9.2 Tenant member can organize conversations with partitions
- #52 9.3 Tenant operator can configure conversation retention policies
- #53 10.1 Tenant operator can configure different providers per agent
- #54 10.2 Tenant operator can test provider configuration directly from the portal

### 2026-03-01: RAG Analytics Planning Complete

**Collaboration:** Kobayashi + Redfoot designed comprehensive RAG analytics framework for gateway layer observability.

**Deliverables Merged:**
- Kobayashi's raw signal specification (6 categories, 20+ metrics captured per-request)
- Redfoot's derived metrics + aggregation strategy (15 metrics, 5 categories)
- Three-phase implementation plan (P0/P1/P2) with phased feature rollout
- Dashboard design for operator and tenant portals

**Key Decisions Documented in `.squad/decisions.md`:**
1. Nullable RAG columns in `traces` table (backward compatible)
2. Similarity scores as JSONB arrays (efficient aggregation, no N+1)
3. Pre-compute `rag_overhead_tokens` at capture time (avoids joins)
4. Separate `embedding_operations` and `artifact_operations` tables for non-request events
5. Real-time 24h dashboard queries with partition pruning; hourly/daily rollups for scale
6. Three-phase rollout: P0 (MVP metrics + basic tiles), P1 (depth + rollups), P2 (granularity + citations)

**Pending:** Stories #64-#67 implementation (schema, ingestion, dashboard UI). Story #68 (pending) for advanced quality signals.

**Open Questions for Team:** Citation format, chunk utilization threshold (>40%?), retrieval granularity (table vs JSONB), embedding provider pricing expansion, alert thresholds.
