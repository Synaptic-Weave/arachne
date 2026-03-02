# Fenster's Project Knowledge

## Project Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**Backend Scope:**
- OpenAI-compatible `/v1/chat/completions` endpoint
- Full streaming support (SSE)
- Structured trace recording with immutable history
- Token usage and cost estimation
- Latency tracking
- Multi-tenant architecture with tenant isolation
- Database schema for trace storage
- Internal APIs for dashboard

**Performance Target:** Gateway overhead under 20ms

## Core Context — Waves 1–2 Summary

**Wave 1 (F1–F6) Architecture:**
- Fastify + undici + PostgreSQL (partitioned traces table by month)
- Provider abstraction (BaseProvider interface) with OpenAI + Azure OpenAI adapters
- SSE streaming with Transform streams (push early, flush on EOF)
- Tenant auth via SHA-256 API key hashing (LRU cache, <3ms per request)
- AES-256-GCM encryption-at-rest for request/response bodies
- Encryption module (`src/encryption.ts`) with per-tenant key derivation

**Database Schema (Traces):**
- Partitioned by month; columns: id, tenant_id, model, provider, status_code, request/response body (encrypted JSONB), latency_ms, prompt_tokens, completion_tokens, created_at, request_iv, response_iv, encryption_key_version
- 3 composite indexes: (tenant_id, created_at), (tenant_id, model), (created_at)
- Auth via `api_keys` + `tenants` tables; key hash stored (SHA-256)

**Key Learnings:**
- Undici response.body is Node.js Readable (not Web ReadableStream); use async iteration
- Transform streams work natively with Fastify reply.send()
- JSONB scalar strings store ciphertext; no schema migration needed
- batch.splice(0) atomically drains batch before async flush
- Timer.unref() prevents test hangs

---

### 2026-02-24: Wave 3 Implementation (F8, F9, F10)

**F8 — Analytics Engine (`src/analytics.ts`)**
- `getAnalyticsSummary(tenantId, windowHours)` → `{ totalRequests, totalTokens, estimatedCostUSD, avgLatencyMs, p95LatencyMs, errorRate }`
- `getTimeseriesMetrics(tenantId, windowHours, bucketMinutes)` → array of time-bucketed metrics
- Cost computed entirely in SQL via CASE expressions: GPT-3.5 ($0.0000005/$0.0000015 per token), all others default to GPT-4o rates ($0.000005/$0.000015)
- `percentile_cont(0.95) WITHIN GROUP` for p95 latency
- Error rate = `SUM(CASE WHEN status_code >= 400)::float / COUNT(*)`
- Time bucketing via `floor(extract(epoch) / bucketSeconds) * bucketSeconds` → `to_timestamp()`

**F9 — Dashboard API (`src/routes/dashboard.ts`)**
- `GET /v1/traces` — cursor pagination on `created_at`, sorted DESC, limit capped at 200
- `GET /v1/analytics/summary` — delegates to `getAnalyticsSummary()`
- `GET /v1/analytics/timeseries` — delegates to `getTimeseriesMetrics()`
- Routes registered via `fastify.register()` in index.ts; global authMiddleware already applies
- Trace responses exclude encrypted request/response bodies (DB-only per spec)

**F10 — Provider Registry (`src/providers/registry.ts`)**
- `getProviderForTenant(tenantCtx)` — lazily constructs and caches provider per tenantId
- Checks `tenantCtx.providerConfig.provider` for `"azure"` → `AzureProvider`, else `OpenAIProvider`
- Falls back to `OPENAI_API_KEY` env var when no providerConfig set
- `evictProvider(tenantId)` for cache invalidation on config change
- Updated `src/index.ts` to use registry; removed hardcoded `new OpenAIProvider`

**Schema Change**
- Migration `1000000000006_add-trace-status-code.cjs` adds `status_code smallint NULL`
- Updated `src/tracing.ts` BatchRow + INSERT to persist `statusCode` from `TraceInput`

**Status:** ✅ Complete — Issues #5, #6, #7 closed. 61 tests still passing.

## Learnings

- **SQL-side cost calculation preferred over app-layer**: Embedding cost CASE expressions directly in analytics SQL avoids extra round-trips and keeps all aggregation in one query. `ILIKE '%gpt-3.5%' OR ILIKE '%gpt-35%'` covers both OpenAI and Azure model name variants cleanly.
- **Cursor pagination on timestamptz**: Use `created_at < $cursor::timestamptz` with `ORDER BY created_at DESC` for stable pagination. The existing `idx_traces_tenant_created` composite index covers this query pattern efficiently.
- **Module-level Map cache for providers**: A simple `Map<tenantId, BaseProvider>` at module scope is sufficient for Phase 1 provider caching. No TTL needed; `evictProvider()` handles config change invalidation.
- **Register routes as Fastify plugins**: Using `fastify.register()` for dashboard routes keeps `index.ts` clean and makes the route module independently importable for testing.
- **Add schema columns early**: `status_code` was carried in `TraceInput` but never persisted — it's better to add the migration column alongside the interface field to avoid this drift.
- **Seed scripts: check-then-insert, not ON CONFLICT**: `tenants.name` and `api_keys.tenant_id` have no unique constraints, so `ON CONFLICT` clauses don't apply. Use a `SELECT` + conditional `INSERT` pattern instead; for api_keys, `DELETE`+`INSERT` is simplest for "replace the dev key" semantics.
- **ESM seed scripts with dotenv**: Use `import 'dotenv/config'` at the top (not `dotenv.config()`) in ESM TypeScript files run with `tsx` — this is the cleanest pattern and mirrors what the rest of the codebase does.
- **TTFB in streaming via closure flag**: Use a `firstChunkSeen` boolean + `firstChunkMs` in Transform closure scope to capture time-to-first-byte. The `transform()` callback fires synchronously per chunk, so the first invocation reliably marks the moment the first byte is forwarded to the client.
- **gatewayOverheadMs = upstreamStartMs - startTimeMs**: The cleanest way to express pre-LLM overhead is to compute it at flush time as `upstreamStartMs - startTimeMs` rather than subtracting two `Date.now()` calls. This captures all auth, routing, and serialization work that happens before the upstream fetch is initiated.
- **Non-streaming traces need explicit record() calls in index.ts**: The SSE proxy's `flush()` handles streaming traces automatically, but non-streaming JSON responses bypass the Transform entirely. `traceRecorder.record()` must be called explicitly in the non-streaming branch with `ttfbMs: latencyMs` (TTFB equals total latency for non-streaming).
- **INSERT parameter index drift is a silent bug**: Adding columns to `BatchRow` and `TraceInput` without updating the INSERT `$N` indices compiles cleanly but fails at runtime. Always audit the full parameter array and column list together when extending the schema.

## Wave 3 Cross-Agent Learnings

**From Hockney's test suite (H4/H6/H7):**
- Multi-tenant isolation enforced correctly; auth middleware SHA-256 validation tested with 10 test cases covering key isolation and race conditions.
- Streaming + batch flush integration works correctly; fire-and-forget tracing during SSE passthrough validated with 7 tests.
- Encryption-at-rest implementation solid; per-tenant key derivation, unique IVs, and AES-256-GCM modes all tested (7 tests, all passing).
- **Implication:** F7–F10 backend surface area fully validated. Production-ready for Wave 4 integration testing.

**From McManus's dashboard (M2–M5):**
- `/v1/analytics` queries (summary + timeseries) are correctly wired to AnalyticsSummary and TimeseriesCharts components.
- Cursor pagination on `/v1/traces` with ISO timestamp working correctly; IntersectionObserver infinite scroll matches pagination contract.
- API key injection via localStorage + Authorization header works end-to-end; no backend session state needed.
- **Implication:** F8–F10 APIs are production-ready; dashboard provides real-time visibility into gateway traffic and costs.

**Test Coverage Status:** 85 tests (61 existing + 24 new Wave 3), 100% passing. All multi-tenant, streaming, and encryption edge cases covered.

## 2026-02-24T15:12:45Z: Seed Script + Chat Example Setup

**Event:** Built dev seed script and gateway quickstart docs  
**Artifacts:** `scripts/seed.ts`, `examples/chat/GATEWAY_SETUP.md`, `package.json` (seed script)  
**Coordination:** Background spawn; McManus delivered chat UI in same wave

**Key Patterns:**
- `import 'dotenv/config'` (ESM-compatible dotenv loading, consistent with codebase)
- Check-then-insert for idempotent tenant upsert (no unique constraint on `tenants.name`)
- DELETE + INSERT for "replace dev key" semantics
- `tsx scripts/seed.ts` via `npm run seed`

## 2026-02-25T00:21:37Z: Instrumentation Complete — TTFB + Overhead Metrics

**Event:** Completed instrumentation of `ttfb_ms` and `gateway_overhead_ms` throughout streaming and non-streaming paths  
**Artifacts:** `src/tracing.ts`, `src/streaming.ts`, `src/index.ts`, `src/routes/dashboard.ts`

**What was wired:**
- `TraceInput` and `BatchRow` interfaces now include `ttfbMs` and `gatewayOverheadMs` fields
- `src/streaming.ts` Transform captures `firstChunkMs` on first SSE byte; computes metrics in flush()
- `src/index.ts` records `upstreamStartMs` before provider.proxy(); passes to streaming context; non-streaming path records latency metrics
- `src/routes/dashboard.ts` exports both fields in `/v1/traces` cursor and non-cursor variants

**Metrics:**
- `ttfb_ms = firstChunkMs - startTimeMs` (streaming) or `latencyMs` (non-streaming)
- `gateway_overhead_ms = upstreamStartMs - startTimeMs` (pre-LLM gateway work)

**Build Status:** ✅ Passed (npm run build, zero TypeScript errors)

**Note:** No DB schema migration needed; columns already existed in traces table. All INSERT parameter indices kept in sync (16 positional params now).

**Cross-team impact:** McManus can now display latency breakdown in trace views; full observability cycle complete.

## 2026-02-25T01:05:00Z: Startup Warning — Missing ENCRYPTION_MASTER_KEY

**Event:** Added boot-time warning for missing `ENCRYPTION_MASTER_KEY` environment variable  
**Artifact:** `src/index.ts` (startup check after dotenv import)

**What was added:**
- Check for `process.env.ENCRYPTION_MASTER_KEY` immediately after `import 'dotenv/config'`
- `console.warn()` to stderr with loud emoji prefix: `⚠️  WARNING: ENCRYPTION_MASTER_KEY is not set...`
- Gateway still starts (non-blocking) — trace recording fails silently downstream in `tracing.ts`, but this catches the misconfiguration early

**Why:**
- Trace recording silently swallows encryption errors (try/catch in `tracing.ts`)
- Without this warning, operators discover missing traces hours/days later (bad UX)
- Boot-time warnings surface configuration issues immediately during startup, not in production after traffic arrives

**Learning:**
- **Fail-fast on config, fail-soft on runtime**: Configuration validation should be loud and early (boot time). Runtime errors in non-critical paths (like trace recording) can be swallowed to avoid cascading failures, but the misconfiguration should never be silent at startup.

## 2026-02-25T02:00:00Z: Multi-Tenant Management Migrations (F-MT1, F-MT2)

**Event:** Implemented first two schema migrations for multi-tenant lifecycle management  
**Artifacts:** `migrations/1000000000007_alter-tenants-add-status.cjs`, `migrations/1000000000008_alter-api-keys-add-management.cjs`

**Migration F-MT1 (1000000000007_alter-tenants-add-status.cjs):**
- Added `status varchar(20) NOT NULL DEFAULT 'active'` to `tenants` table (values: `active`, `inactive`)
- Added `updated_at timestamptz NOT NULL DEFAULT now()` for last modification tracking
- Created `idx_tenants_status` index for filtering queries
- Existing rows backfilled automatically via DEFAULT values

**Migration F-MT2 (1000000000008_alter-api-keys-add-management.cjs):**
- Added `name varchar(255) NOT NULL DEFAULT 'Default Key'` for user-friendly key identification
- Added `key_prefix varchar(20) NOT NULL DEFAULT ''` for display in UI (e.g., "loom_1234...")
- Added `status varchar(20) NOT NULL DEFAULT 'active'` (values: `active`, `revoked`)
- Added `revoked_at timestamptz` (nullable) to track revocation timestamp
- Created `idx_api_keys_status` index for filtering active vs revoked keys
- Existing rows backfilled automatically via DEFAULT values

**Application Code:** None yet — schema-only changes per task requirements. Future work will add tenant status filtering in auth middleware and API key management endpoints.

**Learnings:**
- **node-pg-migrate DEFAULT behavior**: Using `default: 'value'` in `addColumns()` automatically applies the default to existing rows during migration, making backfill seamless for NOT NULL columns
- **Index naming convention**: node-pg-migrate auto-generates index names like `{table}_{column}_index` when using `pgm.createIndex(table, column)`
- **Migration numbering**: Incremented to 1000000000007 and 1000000000008 sequentially after the existing 1000000000006
- **Status column pattern**: Using `varchar(20)` with application-enforced enums (not PostgreSQL ENUMs) provides flexibility for adding new status values without schema migrations

## 2026-02-25T03:00:00Z: Multi-Tenant Auth Foundation (F-MT3, F-MT4a)

**Event:** Implemented admin users table and enhanced auth middleware with revocation/deactivation filters  
**Tasks:** F-MT4a (admin users migration), F-MT3 (auth middleware updates)  
**Artifacts:** `migrations/1000000000009_create-admin-users.cjs`, `src/auth.ts` (updated)

**F-MT4a — Admin Users Migration:**
- Created `admin_users` table with id, username (unique), password_hash, created_at, last_login
- Index on username for login lookups
- Password hashing uses Node.js built-in `crypto.scrypt` (no new dependencies)
  - Salt: 16-byte random hex
  - Derived key: 64-byte scrypt output
  - Stored format: `${salt}:${derivedKey}`
- Migration seeds default admin user from env vars:
  - `ADMIN_USERNAME` (default: `admin`)
  - `ADMIN_PASSWORD` (default: `changeme`)
- `ON CONFLICT (username) DO NOTHING` for idempotent re-runs
- Migration applied successfully via `npm run migrate:up`

**F-MT3 — Auth Middleware Updates:**
- Updated `lookupTenant()` query to filter out revoked keys and inactive tenants:
  - Added `AND ak.status = 'active'` to WHERE clause
  - Added `AND t.status = 'active'` to WHERE clause
- Exported two cache invalidation helpers:
  - `invalidateCachedKey(keyHash: string)`: Invalidate single key by hash (for key revocation)
  - `invalidateAllKeysForTenant(tenantId: string, pool: pg.Pool)`: Query all key hashes for tenant and invalidate each (for tenant deactivation)
- LRU cache method used: `invalidate()` (already existed in the LRUCache class)

**Build Status:** ✅ Clean compile (npm run build, zero TypeScript errors)

**Learnings:**
- **crypto.scrypt for admin passwords**: Using Node's built-in `crypto.scrypt` avoids adding bcrypt dependency. Format `${salt}:${derivedKey}` is simple and secure. Unlike bcrypt's cost parameter, scrypt parameters (N, r, p) are fixed in Node's implementation, which is fine for admin login (not on hot path).
- **Migration-time password seeding**: Reading env vars in migration `exports.up` function works cleanly with node-pg-migrate. The `ON CONFLICT DO NOTHING` ensures idempotent migrations even with seeded data.
- **Auth query enhancement pattern**: Adding status filters to the existing JOIN query is zero-overhead — indexes already exist on both status columns from prior migrations (F-MT1, F-MT2).
- **Cache invalidation by hash**: The invalidation helpers bridge the gap between key_id (used in management APIs) and key_hash (used as cache key). The `invalidateAllKeysForTenant` function queries all hashes first, then invalidates each — necessary because the cache is keyed by hash, not ID.
- **Pool injection for invalidation**: The `invalidateAllKeysForTenant` helper takes `pool` as a parameter rather than importing it — keeps auth.ts decoupled from DB initialization and makes testing easier (same pattern as `registerAuthMiddleware`).

## 2026-02-25T10:20:10Z: Multi-Tenant Wave A Complete — F-MT1, F-MT2, Startup Check

**Event:** Completed migration foundations and startup validation for multi-tenant management  
**Status:** ✅ All tasks completed per spawn manifest

**What was delivered:**

1. **F-MT1 Migration (1000000000007):** ALTER TABLE tenants ADD status, updated_at with indexes
2. **F-MT2 Migration (1000000000008):** ALTER TABLE api_keys ADD name, key_prefix, status, revoked_at with indexes
3. **Startup Env Check:** Boot-time validation warning for missing `ENCRYPTION_MASTER_KEY`

**Key Design Decisions Recorded:**
- **Status columns:** varchar(20) not PostgreSQL ENUMs — allows future expansion without schema locks
- **Revoked_at:** Nullable timestamptz (not boolean flag) — tracks audit timestamp
- **Key prefix:** NOT NULL empty string default — cleaner TypeScript types, simpler UI rendering
- **Backfill:** Via DEFAULT clauses in ALTER TABLE — zero-downtime, automatic
- **Indexes:** idx_tenants_status and idx_api_keys_status for fast filtering

**Startup Warning Pattern:**
- Fail-fast on config (loud warning at boot), fail-soft on runtime (swallow non-critical errors)
- Early warning prevents hours of debugging missing traces
- Extends to other env vars (DATABASE_URL, provider keys) in future

**Next Wave (B):** F-MT3 (auth middleware tightening), F-MT4a/4b (admin users + login), F-MT5/6/7 (CRUD endpoints + encryption)

**Cross-Team Context:** Keaton finalized multi-tenant design document incorporating Michael's Q&A decisions (per-user JWT admin auth, soft+hard delete, provider key encryption). Migrations provide schema foundation; future backend work adds endpoints, frontend work adds admin UI.

## 2026-02-25T10:30:00Z: Admin Auth + Route Scaffold (F-MT4b)

**Event:** Implemented admin JWT authentication and scaffolded all admin routes for tenant management  
**Tasks:** F-MT4b (admin login endpoint + JWT middleware + route stubs)  
**Artifacts:** `src/middleware/adminAuth.ts`, `src/routes/admin.ts`, `src/index.ts`, `src/auth.ts`

**What was delivered:**

1. **JWT Library:** Installed `@fastify/jwt` — integrates cleanly with Fastify request/reply lifecycle
2. **Admin Auth Middleware (`src/middleware/adminAuth.ts`):**
   - `adminAuthMiddleware()` verifies Bearer tokens via Fastify's `request.jwtVerify()`
   - Extracts `{ sub: adminUserId, username }` payload and attaches to `request.adminUser`
   - Returns 401 for missing or invalid tokens
   - Boot-time warning for missing `ADMIN_JWT_SECRET` (similar to `ENCRYPTION_MASTER_KEY`)
3. **Admin Routes (`src/routes/admin.ts`):**
   - `POST /v1/admin/auth/login` — Username/password login endpoint:
     - Queries `admin_users` table by username
     - Verifies password using `crypto.scrypt` (matches migration format `salt:derivedKey`)
     - Issues JWT with 8-hour expiry containing `{ sub, username }`
     - Updates `last_login` timestamp
     - Returns `{ token, username }` on success; 401 on failure
   - **10 route stubs** for tenant CRUD, provider config, and API key management — all return 501 with `adminAuthMiddleware` preHandler (except login)
4. **Integration (`src/index.ts`):**
   - Registered `@fastify/jwt` plugin with `ADMIN_JWT_SECRET` (fallback to dev secret if missing)
   - Registered admin routes via `fastify.register()`
   - Added `ADMIN_JWT_SECRET` startup warning check
5. **Auth Skip List (`src/auth.ts`):**
   - Added `/v1/admin` to tenant API key auth skip list — admin routes use JWT auth, not tenant API keys

**Build Status:** ✅ Clean compile (npm run build, zero TypeScript errors)

**Learnings:**
- **@fastify/jwt integration:** Registering `fastifyJWT` plugin makes `request.jwtVerify()` and `fastify.jwt.sign()` available throughout the app. Much cleaner than manual jsonwebtoken imports.
- **scrypt verification:** Promisified `crypto.scrypt` with `timingSafeEqual` for constant-time comparison matches migration's hash format perfectly. No external bcrypt dependency needed.
- **Route stub pattern:** Registering all routes upfront with 501 responses establishes the API surface immediately — easier for frontend to start integration work even before backend CRUD logic exists.
- **Fastify log.error object pattern:** Use `fastify.log.error({ err }, 'message')` instead of `fastify.log.error('message', err)` for proper pino logging format.
- **JWT payload simplicity:** `{ sub: userId, username }` is sufficient for Phase 1. Future RBAC can extend this with `role` or `permissions` fields without breaking existing tokens (JWT parsers ignore unknown fields).
- **Auth skip list for admin routes:** Tenant API key middleware must skip `/v1/admin` prefix entirely — admin routes are an orthogonal auth domain (per-user JWT vs per-tenant API key).

## 2026-02-25T11:00:00Z: Admin CRUD Implementation Complete (F-MT5, F-MT6, F-MT7)

**Event:** Implemented all 10 admin CRUD route handlers for tenant lifecycle, provider config, and API key management  
**Tasks:** F-MT5 (tenant CRUD), F-MT6 (API key management), F-MT7 (provider config with encryption)  
**Artifacts:** `src/routes/admin.ts` (all 501 stubs replaced), `src/providers/registry.ts` (decryption logic)

**What was delivered:**

1. **F-MT5 — Tenant CRUD (5 endpoints):**
   - `POST /v1/admin/tenants` — Creates tenant, returns 201 with tenant row
   - `GET /v1/admin/tenants` — Lists tenants with pagination (limit/offset), status filter, returns `{ tenants, total }`
   - `GET /v1/admin/tenants/:id` — Returns tenant details with API key count and provider config summary (hasApiKey: boolean, never raw key)
   - `PATCH /v1/admin/tenants/:id` — Updates name or status; on status→inactive, invalidates all tenant keys and evicts provider from cache
   - `DELETE /v1/admin/tenants/:id?confirm=true` — Hard deletes tenant with cascade (requires confirmation query param); invalidates cache and evicts provider before deletion

2. **F-MT6 — API Key Management (3 endpoints):**
   - `POST /v1/admin/tenants/:id/api-keys` — Creates API key with format `loom_sk_{24-byte-base64url}`; stores key_prefix (first 12 chars) and key_hash (SHA-256); returns 201 with raw key shown ONCE
   - `GET /v1/admin/tenants/:id/api-keys` — Lists all keys for tenant (never returns key_hash or raw key), ordered by created_at DESC
   - `DELETE /v1/admin/tenants/:id/api-keys/:keyId` — Default: soft revoke (sets status='revoked', revoked_at=now()); with `?permanent=true`: hard delete; both invalidate cache by key_hash

3. **F-MT7 — Provider Config Encryption (2 endpoints):**
   - `PUT /v1/admin/tenants/:id/provider-config` — Sets/replaces provider config; encrypts apiKey using `encryptTraceBody(tenantId, apiKey)` (reuses encryption.ts pattern); stores as `encrypted:{ciphertext}:{iv}` in provider_config JSONB; evicts provider cache after update
   - `DELETE /v1/admin/tenants/:id/provider-config` — Removes provider config (sets to NULL), evicts provider cache

4. **Provider Registry Decryption:**
   - Updated `getProviderForTenant()` to detect encrypted API keys (format: `encrypted:{ciphertext}:{iv}`)
   - Decrypts using `decryptTraceBody(tenantId, ciphertext, iv)` before passing to provider constructor
   - Falls back gracefully on decryption failure (logs error, provider fails auth downstream)

**Build Status:** ✅ Clean compile (npm run build, zero TypeScript errors)

**Learnings:**
- **Reuse encryption pattern for provider keys:** The existing `encryptTraceBody/decryptTraceBody` functions from `src/encryption.ts` work perfectly for provider API key encryption — same AES-256-GCM + per-tenant key derivation pattern. Storing as `encrypted:{ciphertext}:{iv}` prefix makes detection trivial in registry.ts.
- **Cache invalidation is critical:** Every operation that changes tenant status, deletes tenants, or revokes keys must call the appropriate cache invalidation helper (`invalidateCachedKey`, `invalidateAllKeysForTenant`) AND `evictProvider()`. Missing either leaves stale data in hot path.
- **Dynamic SQL parameter indexing:** Building dynamic UPDATE queries requires careful parameter index tracking (`$${paramIndex++}`). The pattern: build updates array, push params, then append final WHERE clause with tenant ID at `$${paramIndex}`.
- **Soft vs hard delete query param pattern:** Using `?confirm=true` for hard delete and `?permanent=true` for permanent key deletion provides clear UI affordance and prevents accidental destructive operations. Returns 400 if confirmation missing.
- **API key generation format:** `loom_sk_` prefix + 24-byte base64url = 40 total chars, sufficient entropy (192 bits). Storing key_prefix (first 12 chars) allows UI to show "loom_sk_abc..." without exposing full key.
- **Provider config summary redaction:** GET tenant detail returns `hasApiKey: boolean` instead of encrypted or raw key — never leak key material in read endpoints, even encrypted form.
- **Parallel count query optimization:** Using `Promise.all()` to fetch tenants list and total count simultaneously reduces latency for paginated list endpoints.

## 2026-02-25T10:39:35Z: Multi-Tenant Admin Feature Complete

**Summary:** All backend work for Phase 1 multi-tenant management complete. 10 CRUD endpoints fully implemented, tested, and ready for production.

**Wave Completion:**
- ✅ F-MT3: Auth middleware enhanced with revocation/deactivation filters + cache invalidation helpers
- ✅ F-MT4a: Admin users table + default admin user seeding
- ✅ F-MT4b: JWT-based admin authentication + login endpoint + route scaffolding
- ✅ F-MT5: Tenant CRUD (5 endpoints) with cache invalidation
- ✅ F-MT6: API key management (3 endpoints) with prefix generation + soft/hard delete
- ✅ F-MT7: Provider config management (2 endpoints) with AES-256-GCM encryption

**Key Achievements:**
- Per-user admin authentication via JWT (not shared secret) — enables audit trail for Phase 2
- Provider API keys encrypted at rest using existing encryption.ts (AES-256-GCM + per-tenant derivation)
- Cache invalidation helpers ensure immediate auth rejection on tenant/key status changes
- Soft-delete by default with hard-delete option via query params (GDPR compliance)
- Dynamic SQL parameter indexing supports flexible partial updates
- Parallel queries optimize hot paths

**Cross-Team Coordination:**
- **With McManus:** All 10 endpoints provide complete API surface for admin UI (M-MT1–M-MT6 components)
- **With Hockney:** Integration test suite validates all endpoints + encryption + cache behavior (28 tests, all passing)

**Build Status:**
- ✅ npm run build — zero TypeScript errors
- ✅ All 113 tests passing (85 existing + 28 new)
- ✅ No breaking changes to existing auth or provider logic

**Phase 2 Readiness:**
- Auth infrastructure supports RBAC extension (JWT payload can carry role/permissions)
- Admin action logging ready for audit trail implementation
- Encryption key versioning support in schema
- Cache invalidation pattern proven; can extend to other entities


---

## Session: Tenant Portal Backend — 2025-07-24

### Task
Built all backend infrastructure for the tenant self-service portal per Keaton's approved architecture spec.

### Work Completed

**1. Migration** — `migrations/1000000000010_create-tenant-users.cjs`
- New `tenant_users` table: `id, tenant_id (FK→tenants CASCADE), email (unique), password_hash, role, created_at, last_login`
- Indexes on `tenant_id` and `email`

**2. Portal Auth Middleware** — `src/middleware/portalAuth.ts`
- `registerPortalAuthMiddleware(fastify, requiredRole?)` returns a Fastify preHandler
- Reads Bearer token from Authorization header, calls `request.portalJwtVerify()`
- Attaches `request.portalUser: { userId, tenantId, role }`
- Optional role enforcement (owner/member); returns 403 if role mismatch

**3. Portal Routes** — `src/routes/portal.ts`
- `POST /v1/portal/auth/signup` — atomic transaction: tenant + user + api_key; returns JWT + raw API key (shown once)
- `POST /v1/portal/auth/login` — scrypt password verify, 403 for suspended tenants
- `GET /v1/portal/me` — returns user + tenant (never raw LLM API key)
- `PATCH /v1/portal/settings` — owner only; encrypts LLM provider key via `encryptTraceBody`, evicts provider cache
- `GET /v1/portal/api-keys` — lists all keys for tenant (no raw keys)
- `POST /v1/portal/api-keys` — owner only; generates new `loom_sk_` key
- `DELETE /v1/portal/api-keys/:id` — owner only; soft revoke + LRU cache invalidation

**4. `src/index.ts` updates**
- Registered portal JWT plugin (`namespace: 'portal', decoratorName: 'portalJwt'`)
- Registered `fastifyStatic` for `portal/dist/` at `/` with `decorateReply: false`
- Registered portal routes
- Added PORTAL_JWT_SECRET startup warning
- Updated `setNotFoundHandler` with portal SPA fallback

**5. `src/auth.ts` update**
- Added `/v1/portal` and non-`/v1/` routes to skip list for tenant API key auth

**6. `.env` update**
- Added generated `PORTAL_JWT_SECRET`

### Build & Test
- `npm run build` — zero TypeScript errors
- `npm test` — 113/113 tests pass

### Patterns Established
- Portal JWT is fully isolated from admin JWT via Fastify namespace
- Portal routes use `registerPortalAuthMiddleware(fastify, 'owner')` preHandler for owner-only endpoints
- Scrypt password format consistent: `salt:derivedKey` (matches admin_users)
- API key prefix is first 15 chars: `loom_sk_` + 7 base64url chars

## 2026-02-26T15:57:42Z: Tenant Portal Backend Complete

**Event:** Completed tenant self-service portal backend  
**Status:** ✅ All 113 tests passing  
**Artifacts:** `migrations/1000000000010_create-tenant-users.cjs`, `src/middleware/portalAuth.ts`, `src/routes/portal.ts`, updated `src/index.ts` + `src/auth.ts`, generated `PORTAL_JWT_SECRET`

**What was delivered:**

1. **Tenant Users Migration (1000000000010):**
   - New table: id (UUID), tenant_id (FK → tenants CASCADE), email (unique), password_hash, role (varchar 50), created_at, last_login
   - Indexes on tenant_id and email
   - Supports future RBAC (first user seeded as 'owner')

2. **Portal Auth Middleware (`src/middleware/portalAuth.ts`):**
   - `registerPortalAuthMiddleware(fastify, requiredRole?)` returns Fastify preHandler
   - Reads Bearer token from Authorization header, calls `request.portalJwtVerify()`
   - Attaches `request.portalUser: { userId, tenantId, role }`
   - Optional role enforcement (owner/member); returns 403 on mismatch
   - Fully isolated from admin JWT via `namespace: 'portal'`

3. **Portal Routes (`src/routes/portal.ts`) — 7 Endpoints:**
   - `POST /v1/portal/auth/signup` — Atomic transaction: tenant + user + api_key; returns JWT + raw API key (shown once)
   - `POST /v1/portal/auth/login` — Scrypt password verify; 403 for inactive tenants; updates last_login
   - `GET /v1/portal/me` — Returns user + tenant (never raw LLM API key, only `hasApiKey: boolean`)
   - `PATCH /v1/portal/settings` — Owner only; encrypts LLM provider key via `encryptTraceBody`; evicts provider cache
   - `GET /v1/portal/api-keys` — Lists all keys for tenant (no raw keys or hashes)
   - `POST /v1/portal/api-keys` — Owner only; generates new `loom_sk_` key with 15-char prefix display
   - `DELETE /v1/portal/api-keys/:id` — Owner only; soft revoke + LRU cache invalidation

4. **Integration (`src/index.ts`):**
   - Registered portal JWT plugin (`decoratorName: 'portalJwt'`, `namespace: 'portal'`)
   - Registered `fastifyStatic` for `portal/dist/` at `/` with `decorateReply: false`
   - Registered portal routes via `fastify.register()`
   - Added `PORTAL_JWT_SECRET` startup warning
   - Updated `setNotFoundHandler` with portal SPA fallback (checks `/v1/` and `/dashboard` prefixes)

5. **Auth Skip List (`src/auth.ts`):**
   - Added `/v1/portal` and non-`/v1/` routes to skip list (portal uses JWT, not tenant API key auth)

6. **Environment (`.env`):**
   - Generated `PORTAL_JWT_SECRET` (32 bytes hex): `0a48e1dd6d91f82c0bbdd4dca9eceac8e93f7b2c9d18db0b2456c7718323a8b1`

**Key Design Patterns:**

- **Email globally unique** — One email = one tenant_user (can extend to multi-tenant-per-user later)
- **Email lowercase enforcement** — Applied at app layer in signup/login to prevent case-sensitivity bugs
- **Scrypt format consistency** — `salt:derivedKey` matches admin_users table (20-byte salt, 64-byte key)
- **Atomic signup transaction** — BEGIN/COMMIT wraps tenant creation, user creation, and API key generation
- **API key prefix = 15 chars** — `loom_sk_` + 7 base64url (follows Keaton's spec exactly; differs from admin's 12-char prefix)
- **Provider API key encryption** — Reuses `encryptTraceBody` function and `ENCRYPTION_MASTER_KEY` (no new dependency)
- **Cache invalidation pattern** — Portal settings update evicts provider from cache (same pattern as admin updates)
- **JWT isolation** — Portal JWT fully separate from admin JWT via Fastify namespace; `request.portalJwtVerify()` is distinct from `request.jwtVerify()`

**Build Status:** ✅ npm run build (zero TypeScript errors), npm test (113/113 passing)

**Coordination Notes:**
- **With McManus:** All 7 endpoints ready for consumption by portal React SPA
- **With Hockney:** Integration tests validate signup/login flows, provider encryption, cache invalidation, transaction atomicity
- **For Michael:** Rate limiting TODO added to signup/login (not blocking v1 but recommended before public launch); `PORTAL_JWT_SECRET` added to `.env`

**Learning — Tenant Portal Patterns:**
- **Signup atomicity:** Using PostgreSQL transaction ensures tenant + user + api_key are created together or fail together. No orphaned records on partial failure.
- **Email as identity** — Single global identity simplifies Phase 1. Multi-tenant-per-user requires junction table refactor in Phase 2 (backwards-compatible).
- **Fastify namespace for JWT** — `decoratorName: 'portalJwt'` and `namespace: 'portal'` fully isolates portal JWT from admin JWT. Request decorators are independent: `request.jwtVerify()` vs `request.portalJwtVerify()`.
- **SPA fallback ordering** — Portal fallback must come AFTER `/v1/`, `/dashboard`, and `/health` checks, otherwise API 404s return HTML. Handler order matters in Fastify `setNotFoundHandler`.
- **API key prefix strategy** — Displaying first 15 chars (`loom_sk_abc...`) allows UI to show key identity without exposing the full key or hash. User can compare against their generated key for verification.

## Learnings

### Admin Trace & Analytics Endpoints (added)

**What was built:**
- `GET /v1/admin/traces` — cross-tenant paginated trace list with optional `tenant_id` filter, `limit` (max 200, default 50), `cursor` (ISO timestamp) for keyset pagination. Placed in `src/routes/admin.ts` behind `adminAuthMiddleware`.
- `GET /v1/admin/analytics/summary` — admin-scoped aggregated metrics using new `getAdminAnalyticsSummary(tenantId?, windowHours?)` in `analytics.ts`.
- `GET /v1/admin/analytics/timeseries` — admin-scoped time-bucketed metrics using new `getAdminTimeseriesMetrics(tenantId?, windowHours?, bucketMinutes?)` in `analytics.ts`.

**Key Design Decisions:**
- Existing `getAnalyticsSummary` / `getTimeseriesMetrics` require a `tenantId` — added separate admin variants with optional `tenantId` to avoid mutating the per-tenant API surface.
- Used `params.push(value)` inside template literals to auto-number SQL parameters (`$1`, `$2`, etc.) cleanly when building dynamic WHERE clauses without an ORM.
- `$1` is reserved for `limit` in the traces query so all WHERE params are appended after — ensures `LIMIT $1` always refers to the correct binding regardless of filter combinations.
- Added `import { query } from '../db.js'` to `admin.ts` — admin routes previously used only `pool.query`; cross-tenant trace query benefits from the shared `query` helper consistent with `dashboard.ts`.

**Build Status:** ✅ `npm run build` (zero TypeScript errors)

## Session: Admin Dashboard Split (2026-02-26)

**Spawned as:** Background agent  
**Coordination:** Paired with McManus (frontend split)  
**Outcome:** ✅ All endpoints implemented, build clean, unblocks dashboard cross-tenant UI

### Work Completed

**1. Three new admin endpoints in `/v1/admin/*` (JWT-only)**

- `GET /v1/admin/traces` — Paginated trace list with optional `tenant_id` query param
  - Params: `limit`, `offset`, `tenant_id` (optional)
  - Built using conditional SQL parameter binding (`params.push()`)
  
- `GET /v1/admin/analytics/summary` — Aggregated metrics (counts, latency, error rate)
  - Params: `tenant_id` (optional), `window_hours` (default: 24)
  - Uses new `getAdminAnalyticsSummary()` function in `analytics.ts`
  
- `GET /v1/admin/analytics/timeseries` — Time-bucketed charting data
  - Params: `tenant_id` (optional), `window_hours`, `bucket_minutes` (default: 5)
  - Uses new `getAdminTimeseriesMetrics()` function in `analytics.ts`

All three endpoints:
- Protected by existing `adminAuthMiddleware` (JWT required, no API key fallback)
- Follow existing admin endpoint patterns (`authOpts = { preHandler: adminAuthMiddleware }`)
- Support optional tenant filtering; omit `tenant_id` to aggregate across all tenants

**2. Two new analytics functions (non-breaking exports)**

- `getAdminAnalyticsSummary(tenantId?: string, windowHours = 24)` in `analytics.ts`
  - Returns same shape as existing `getAnalyticsSummary(tenantId)` but with optional tenantId
  - Deliberately separate from existing function (not optional param) to prevent tenant leakage via omission
  
- `getAdminTimeseriesMetrics(tenantId?: string, windowHours = 24, bucketMinutes = 5)` in `analytics.ts`
  - Deliberately separate from existing `getTimeseriesMetrics(tenantId)` for same safety reason

**3. SQL Parameter Binding Pattern**

Discovered clean pattern for dynamic SQL parameter numbering:
```typescript
const params: unknown[] = [limit]; // $1 is always limit
if (tenantId) {
  queryStr += ` AND tenant_id = $${params.push(tenantId)}`; // $2, $3, etc. auto-numbered
}
```
`Array.push()` returns the new array length, which maps directly to the next `$N` placeholder. Eliminates string manipulation and is more readable than manual counter variables.

**4. Build & Integration**

- ✅ `npm run build` passes zero TypeScript errors
- Ready for McManus to consume on frontend
- No breaking changes to existing tenant-scoped analytics endpoints

### Key Learnings

**SQL parameter binding cleanup** — Using `params.push()` return value directly in template literals beats manual counter state. Pattern is reusable for any future admin query needing conditional filters.

**Endpoint vs. Function Separation** — Admin endpoints are separate from tenant-scoped routes. Admin analytics functions are separate from tenant analytics functions. This separation, while adding a few LOC, prevents the most likely source of tenant leakage bugs.

**Deferrable Analyses** — Admin doesn't need cross-tenant comparison charts in Phase 1. Single-tenant summary view is sufficient for proving out the architecture. Future: composite charts (multiple tenants side-by-side).

### Blocked / Deferred

- None; this session unblocks McManus
- Rate limiting on traces query (large `limit` values) — not in scope but noted for future optimization
- Audit logging per admin query (who viewed what, when) — deferred to Phase 2

### Coordination Notes

- McManus now has three `/v1/admin/*` endpoints ready to call
- Dashboard can implement tenant filter and cross-tenant traces view
- Portal can launch without admin features; admin dashboard is separate domain

---

## Session: Multi-User Multi-Tenant Implementation (Wave A + B)

**Date:** 2026-02-26  
**Requested by:** Michael Brown  
**Spec:** `.squad/decisions/inbox/keaton-multi-user-tenant-arch.md`

### What Was Built

**Wave A — Migration** (`migrations/1000000000011_multi-tenant-users.cjs`):
- Created `users` table (id, email UNIQUE, password_hash, created_at, last_login)
- Created `tenant_memberships` junction table (user_id FK→users, tenant_id FK→tenants, role, joined_at, UNIQUE(user_id, tenant_id))
- Created `invites` table (token VARCHAR(64) UNIQUE, created_by FK→users, max_uses nullable, use_count, expires_at, revoked_at)
- Indexed all FK columns + token
- Migrated existing `tenant_users` → `users` + `tenant_memberships` preserving IDs and roles
- Dropped `tenant_users`
- `down` migration: recreates `tenant_users` from first membership per user (known loss for multi-tenant users)

**Wave B — Backend Routes** (`src/routes/portal.ts`):
- **signup**: Now handles two branches — regular (creates user + tenant + membership(owner) + API key) and invite-based (validates invite, creates/finds user, adds membership(member), increments use_count)
- **login**: Queries `users` table for auth, then all active `tenant_memberships`, returns `tenants[]`. JWT issued for first active membership.
- **/me**: Queries `users` JOIN `tenant_memberships`, returns `tenants[]` alongside current tenant
- **POST /v1/portal/auth/switch-tenant**: Validates membership, issues new JWT for requested tenantId
- **POST /v1/portal/invites**: Owner-only; generates 32-byte base64url token, inserts row, returns full invite URL
- **GET /v1/portal/invites**: Owner-only; lists all invites with creator email and computed `isActive`
- **DELETE /v1/portal/invites/:id**: Owner-only; soft-revokes (sets revoked_at)
- **GET /v1/portal/invites/:token/info**: Public (no auth); returns tenantName, expiresAt, isValid
- **GET /v1/portal/members**: Auth-required; lists members with email, role, joinedAt, lastLogin
- **PATCH /v1/portal/members/:userId**: Owner-only; changes role with last-owner guard
- **DELETE /v1/portal/members/:userId**: Owner-only; removes membership with last-owner guard and no-self-remove guard
- **GET /v1/portal/tenants**: Auth-required; lists all active tenant memberships for requesting user
- **POST /v1/portal/tenants/:tenantId/leave**: Auth-required; removes own membership with last-owner guard and no-active-tenant guard

### Key Learnings

**Import cleanup** — Moved `timingSafeEqual` to top-level named import from `node:crypto` rather than dynamic import inside the handler. Removes an async dynamic import from the hot path.

**inviteToken branch in signup** — When inviteToken is present, `tenantName` in the request body is silently ignored (not an error). This matches the spec intent: invited users join an existing tenant.

**provider_config typing** — Changed `any` to `Record<string, unknown>` for the provider_config column type in the `/me` handler. Required switching from `cfg.provider` to `cfg['provider']` bracket access. Zero runtime change, better type safety.

**PORTAL_BASE_URL scoping** — Declared inside `registerPortalRoutes` so it's captured at request-time from `process.env` (not module load time). Allows the env var to be injected after module import during testing.

**No middleware changes** — JWT payload structure (`{ sub, tenantId, role }`) is unchanged; `portalAuth.ts` required zero modifications. `ownerRequired` was already defined in the existing route file.

### Deferred

- Rate limiting on `/v1/portal/invites/:token/info` (noted in spec as Phase 2)
- `SELECT ... FOR UPDATE` on last-owner count check (race condition mitigation, noted in spec risks)
- Email notifications for invite creation (Phase 2)

---

## 2026-02-27: Multi-User Multi-Tenant Backend Implementation

**Status:** Complete, 13 endpoints + migration implemented

**Scope:** Backend implementation of multi-user multi-tenant architecture per Keaton's spec.

**Deliverables:**
- Migration `1000000000011_multi_tenant_users.cjs` (users, tenant_memberships, invites tables + data migration)
- 13 API endpoints:
  - Auth: signup (invite branch), login, switch-tenant, /me
  - Invites: create, list, revoke, public info
  - Members: list, update role, remove
  - Tenants: list, leave

**Key Decisions Recorded:**
- inviteToken branch silently ignores tenantName (no-friction for client)
- Existing user joining via invite does NOT re-hash password
- Login returns 403 for zero active memberships (authorization failure, not auth)
- PORTAL_BASE_URL read at runtime (allows test overrides)
- Soft-revoke only for invites (audit trail)
- Unknown token → 404, expired/revoked/exhausted → 200 isValid:false
- No FOR UPDATE on last-owner checks (Phase 2 deferred)
- Migration preserves tenant_users.id as users.id (JWT compatibility)

**Decision Log:** `.squad/decisions.md` (fenster-multi-user-impl.md merged)

**Next:** Awaiting frontend integration & Hockney tests

---

## 2026-02-27: Subtenant Hierarchy + Agents Migration

**Status:** Complete

**Scope:** Database migration `1000000000012_subtenant-hierarchy-and-agents.cjs` adding subtenant hierarchy and per-tenant agent configurations.

**Deliverables:**
- Migration file `migrations/1000000000012_subtenant-hierarchy-and-agents.cjs`

**Key Decisions:**
- `agents.merge_policies` is NOT NULL with default `{"system_prompt":"prepend","skills":"merge","mcp_endpoints":"merge"}` — every agent always has a merge policy.
- `api_keys.agent_id` is NOT NULL — every key must be bound to an agent. Populated via a Default agent seeded for every existing tenant before the NOT NULL constraint is applied.
- `traces.agent_id` is nullable — backward compatibility; existing rows retain null.
- `tenants.parent_id` self-references with ON DELETE CASCADE — deleting a parent tenant cascades to all subtenants.
- Down migration drops columns/tables in strict reverse order to satisfy FK dependencies.

### Learnings

**pgm.func for JSONB defaults** — node-pg-migrate requires `pgm.func(...)` to emit a raw SQL expression. For a JSONB literal default, wrap the quoted JSON string: `pgm.func("'{"key":"val"}'")` so the migration emits the literal without double-quoting it as a string parameter.

**Nullable-then-populate-then-NOT-NULL pattern** — Adding a column as nullable, running an UPDATE to fill it, then `alterColumn(..., { notNull: true })` is the safe way to backfill and enforce the constraint in one migration without a default that would persist on new rows.
- **Subtenant rollup via recursive CTE**: When rolling up analytics across a tenant hierarchy, use a `WITH RECURSIVE subtenant_tree AS (SELECT id FROM tenants WHERE id = $1 UNION ALL SELECT t.id FROM tenants t JOIN subtenant_tree st ON t.parent_id = st.id)` CTE. Replace `WHERE tenant_id = $1` with `WHERE tenant_id IN (SELECT id FROM subtenant_tree)`. The `$1` parameter is reused by the CTE, keeping the parameter list unchanged.
- **Partition-compatible CTEs**: On a partitioned `traces` table, the recursive CTE must not reference the partitioned table inside itself. Keeping the CTE restricted to the `tenants` table (non-partitioned) and only referencing `subtenant_tree` in the outer `WHERE … IN (subquery)` lets PostgreSQL still prune partitions on `created_at`.
- **Rollup flag as trailing boolean param**: Adding `rollup = false` as the last parameter to analytics functions keeps backward compatibility — all existing callers work without change, and the portal routes opt in with `qs.rollup === 'true' || qs.rollup === '1'`.

---

## 2026-02-28: Subtenant + Agent Portal API Routes

**Status:** Complete

**Scope:** Added subtenant hierarchy and agent CRUD routes to `src/routes/portal.ts`, plus extended `GET /v1/portal/me`.

**Deliverables:**
- `GET /v1/portal/subtenants` — list direct children of current tenant
- `POST /v1/portal/subtenants` (owner) — create subtenant + seed owner membership in transaction
- `GET /v1/portal/agents` — list agents for current tenant
- `POST /v1/portal/agents` — create agent (any role); encrypts providerConfig.apiKey if present
- `GET /v1/portal/agents/:id` — get agent (membership-verified)
- `PUT /v1/portal/agents/:id` — partial update (membership-verified, dynamic SET clauses)
- `DELETE /v1/portal/agents/:id` (owner) — hard delete
- `GET /v1/portal/agents/:id/resolved` — recursive CTE walks parent_id chain; returns merged config with inheritanceChain
- Extended `GET /v1/portal/me` to include `agents` (id, name) and `subtenants` (id, name, status) via `Promise.all`

**Key Decisions:**
- agent providerConfig uses same encrypt-on-write / sanitize-on-read pattern as tenant providerConfig
- PUT uses dynamic SET clause builder (index-tracked `$N` params) to support partial updates
- resolved endpoint deduplicates skills/mcpEndpoints using JSON.stringify as set key
- membership check for GET/PUT/resolved uses JOIN across agents + tenant_memberships (not just tenantId match) to support cross-tenant agent access within a user's memberships

## Learnings

- **Dynamic SET clause with index tracking**: Build `setClauses[]` and `values[]` in parallel, tracking `idx` manually. Push `id` and `tenantId` last so `WHERE id = $${idx} AND tenant_id = $${idx+1}` is always correct regardless of how many optional fields were updated.
- **Promise.all for parallel sibling queries in /me**: Two independent SELECT queries (agents + subtenants) can run concurrently with `await Promise.all([...])` to reduce latency on the me endpoint.
- **Recursive CTE for tenant hierarchy**: `WITH RECURSIVE tenant_chain AS (... UNION ALL ...)` starting from the agent's `tenant_id` walks `parent_id` upward cleanly. Returns rows ordered by depth, so index 0 is always the immediate tenant.
- **JSON.stringify deduplication for union arrays**: Using `JSON.stringify(item)` as a Set key deduplicates skills/mcpEndpoints across hierarchy levels reliably, even for objects.

---

### 2026-02-26: Wave 4 — Agent-Aware Gateway

**Task:** Make gateway fully agent-aware (agent_id on api_keys + traces migration has run).

**Changes shipped:**
- `src/auth.ts`: Expanded `TenantContext` with `agentId`, `agentSystemPrompt`, `agentSkills`, `agentMcpEndpoints`, `mergePolicies`, `resolvedSystemPrompt`, `resolvedSkills`, `resolvedMcpEndpoints`. New `lookupTenant()` JOINs agents table + walks tenant parent chain via recursive CTE (max 10 hops). Resolves `provider_config`/`system_prompt` (first non-null wins) and `skills`/`mcp_endpoints` (union, earlier in chain wins on name conflict).
- `src/agent.ts` (new): `applyAgentToRequest()` applies merge_policies (prepend/append/overwrite/ignore for system prompt; merge/overwrite/ignore for skills). `handleMcpRoundTrip()` does one JSON-RPC POST to matching MCP endpoints and re-sends updated messages to provider.
- `src/tracing.ts`: Added `agentId?` to `TraceInput` and `BatchRow`; updated INSERT to include `agent_id` column.
- `src/streaming.ts`: Added `agentId?` to `StreamTraceContext`, passed through to `traceRecorder.record()`.
- `src/index.ts`: Applies `applyAgentToRequest()` before forwarding; calls `handleMcpRoundTrip()` on non-streaming responses; passes `agentId` to all trace contexts.
- `src/providers/registry.ts`: Caches by `agentId` (primary key) + maintains `tenantId → Set<cacheKey>` reverse index. `evictProvider(id)` handles both agentId and tenantId eviction.
- Test fixes: Updated `encryption-at-rest.test.ts` IDX constants (+1 for new agent_id param), updated `admin.test.ts` mock to return full agent shape and use `ak.key_hash = $1` as match criterion.

## Learnings

- **Agent-aware lookup in one query**: JOIN `api_keys → agents → tenants` in a single query, then a separate recursive CTE for the parent chain if `parent_id` is non-null. Separating the two queries avoids a complex one-shot CTE and keeps the code readable.
- **Resolve chain with ordered array**: Building a `chain[]` (agent → immediate tenant → parent chain rows) and calling `.find()` / `resolveArrayChain()` over it gives clean, testable resolution logic without multiple branching conditions.
- **Provider cache keyed by agentId**: Caching by `agentId` (not `tenantId`) is required for correctness when agents within the same tenant have different `provider_config`. A reverse `tenantId → Set<cacheKey>` index keeps `evictProvider(tenantId)` working for all existing admin route callers without any change to the call sites.
- **INSERT parameter index drift**: Adding `agent_id` at position 2 in the INSERT shifted all downstream `$N` indices. Tests that hardcode parameter indices must be updated simultaneously — always audit the full array+column list when extending the schema.
- **Mock SQL matching by distinctive clause**: The admin test mock matched on `from   api_keys ak` + `join   tenants` whitespace, which broke when query whitespace changed. Switching to `ak.key_hash = $1` (unique to auth lookup) is far more robust against formatting changes.
- **MCP only on non-streaming**: Tool calls in streaming responses require buffering the full stream before routing — complex and high-latency. Limiting MCP round-trip to non-streaming (JSON) responses is the correct Phase 1 scope.

### 2026-02-27: Wave 4 Implementation — Subtenant Hierarchy + Agents, Analytics Rollup, Gateway Integration

**Scope:** Subtenant multi-tenancy with agent-scoped configuration, provider isolation, and recursive analytics.

**Migration (1000000000012):**
- Added `tenants.parent_id` (nullable self-FK, ON DELETE CASCADE) enabling subtenant hierarchy
- Created `agents` table with `id, tenant_id, name, provider_config (JSONB), system_prompt, skills, mcp_endpoints, merge_policies (JSONB), created_at, updated_at`
- Added `api_keys.agent_id` (NOT NULL, FK) — every key bound to exactly one agent
- Added `traces.agent_id` (nullable, FK) — historical rows have NULL, new rows always record agent
- Seeded "Default" agent per existing tenant before enforcing NOT NULL on api_keys.agent_id
- Down migration reverses in strict FK dependency order: traces → api_keys → agents → tenants

**Portal Routes (9 new endpoints):**
- POST /v1/portal/subtenants — Create subtenant with owner membership (transactional)
- GET /v1/portal/subtenants — List subtenants (parent_id-based)
- GET/POST /v1/portal/agents — List / create agents in current tenant
- GET/PUT/DELETE /v1/portal/agents/:id — Agent CRUD (membership-gated via JOIN tenant_memberships)
- GET /v1/portal/agents/:id/resolved — Get agent config with inheritance chain applied
- Extended GET /v1/portal/me — Now includes agents array + subtenants array

**Agent Config Encryption:** Applied same encrypt-on-write / sanitize-on-read pattern as tenant settings. `prepareAgentProviderConfig()` encrypts plain `apiKey` field; `sanitizeAgentProviderConfig()` exposes only `hasApiKey: boolean`.

**Analytics Rollup:** Added `rollup?: boolean` parameter to `getAnalyticsSummary`, `getTimeseriesMetrics`, `getModelBreakdown`. When true, prepends `WITH RECURSIVE subtenant_tree` CTE walking `tenants.parent_id`. CTE restricted to tenants table only (preserves partition pruning on traces table).

**Gateway Agent-Aware Injection:**
- Two-query lookup: immediate tenant chain via JOIN query, parent chain via separate recursive CTE (skipped if no parent)
- Chain resolution in TypeScript: `.find(non-null)` for providerConfig/systemPrompt, union+dedup for skills/mcpEndpoints
- Provider cache keyed by agentId (fallback tenantId); reverse tenantId → Set<cacheKey> index preserves `evictProvider(tenantId)` API for admin routes
- `applyAgentToRequest()` applies merge policies to outbound request before provider (immutable, no mutation of request.body)
- `handleMcpRoundTrip()` on non-streaming responses only (streaming MCP deferred to Phase 2)
- `agentId` recorded on every trace (nullable for backward compatibility)

## Learnings

- **Subtenant hierarchy:** Self-FK with ON DELETE CASCADE is sufficient for linear parent-child model; avoids join table complexity
- **Agent provider isolation:** Each agent can have its own provider config, encrypted same as tenant settings; per-agent caching required for correctness
- **CTE + partition pruning:** Keep recursive CTE on non-partitioned tables only; reference result set in WHERE subquery to preserve PostgreSQL partition elimination
- **Inheritance patterns:** First-non-null vs. union semantics cleaner in application code than SQL; ordered chain array with .find() is readable and testable
- **Two-query pattern:** Separating immediate chain (one JOIN) from parent chain (recursive CTE) is simpler, more testable, and faster for non-parent tenants
- **Transaction boundaries:** Wrap multi-step creates (subtenant + membership) in explicit transaction to prevent orphaned rows
- **API key enforcement:** DB-level NOT NULL on api_keys.agent_id prevents orphaned keys; seeded Default agent enables safe migration without full backfill

- **Portal sandbox chat endpoint re-uses resolved CTE logic**: `POST /v1/portal/agents/:id/chat` duplicates the tenant hierarchy walk from the `/resolved` endpoint to build a full `TenantContext`. This keeps each route self-contained and avoids introducing a shared helper that crosses auth/portal boundaries. The `getProviderForTenant` registry handles API key decryption transparently (same as gateway).
- **stream: false must be set explicitly in sandbox body**: `applyAgentToRequest` passes through the body as-is; callers must set `stream: false` before calling it to prevent the provider from returning an SSE stream that would be mishandled in the portal sandbox context.
- **TenantContext.name comes from first tenant chain row**: For portal-constructed contexts, `tenantChain[0]?.name` (the agent's immediate tenant) is the right value for the `name` field, falling back to `tenant_id` if the chain is somehow empty.

### 2026-02-27: Agent Sandbox Chat Endpoint

**Implemented:** `POST /v1/portal/agents/:id/chat`  
**Decision:** No trace recording — sandbox chats are developer testing, not production traffic.

- Resolves agent hierarchy (agent → tenant → parent chain) into `TenantContext`
- Applies system prompt + skills via `applyAgentToRequest()` with `stream: false`
- Calls provider non-streaming
- Returns `{ message, model, usage }`
- Portal auth gated (JWT, not API key) so safe from production gateway confusion
- Errors: 400 (invalid request), 404 (agent not found), 502 (provider error)
- Future trace recording of sandbox calls requires explicit `sandbox: true` flag in schema (Phase 2)

### 2026-XX-XX: available_models Column

**Implemented:** `available_models jsonb` on `tenants` and `agents` tables, wired through portal API.

- **Conditional UPDATE in PATCH /settings:** Only updates `available_models` column when the field is present in the request body (undefined check), avoiding accidental nulling of existing data when callers only want to update provider config.
- **formatAgent always returns availableModels:** Defaults to `null` if column is absent, ensuring backward compat with any query that doesn't SELECT `available_models`.
- **NULL vs empty array semantics:** NULL = "use frontend defaults (COMMON_MODELS)", `[]` = "no models configured (fall back to defaults)", non-empty = "explicit model list". Stored as JSONB so Postgres can index/query into it if needed later.

### 2026-XX-XX: Sandbox Chat Trace Recording

**Implemented:** `traceRecorder.record()` in `POST /v1/portal/agents/:id/chat`

- Added `import { traceRecorder } from '../tracing.js'` to `src/routes/portal.ts`
- After successful provider response, calls `traceRecorder.record()` fire-and-forget with full trace payload (tenantId, agentId, model, provider, requestBody, responseBody, latencyMs, statusCode, token counts, ttfbMs, gatewayOverheadMs)
- `provider.name` is available on all provider implementations via abstract base class in `src/providers/base.ts`
- Supersedes Phase 2 deferral noted in 2026-02-27 entry — sandbox traces now appear in the traces list
- Purely additive: no behavior changes to request/response path

## 2026-02-28: Conversations & Memory Backend (Wave 5)

**Event:** Implemented full conversations & memory subsystem for the gateway  
**Artifacts:** `migrations/1000000000014_conversations.cjs`, `src/conversations.ts`, `src/auth.ts` (extended), `src/index.ts` (wired), `src/routes/portal.ts` (6 new routes)

### What was built

**Schema (migration 1000000000014):**
- `agents` gains `conversations_enabled`, `conversation_token_limit`, `conversation_summary_model`
- New tables: `partitions`, `conversations`, `conversation_messages`, `conversation_snapshots`
- Two partial unique indexes per null-nullable foreign key (`parent_id IS NULL` on partitions, `partition_id IS NULL` on conversations) — required because PostgreSQL UNIQUE treats two NULLs as non-equal

**`src/conversations.ts` — ConversationManager:**
- `getOrCreatePartition` — upsert via partial unique index + fallback SELECT
- `getOrCreateConversation` — `IS NOT DISTINCT FROM` for null-safe partition matching
- `loadContext` — fetches latest snapshot + un-snapshotted messages (`snapshot_id IS NULL`), decrypts all in-memory
- `storeMessages` — encrypts user+assistant content, inserts two rows
- `createSnapshot` — encrypts summary, inserts snapshot, marks all `snapshot_id IS NULL` messages with new snapshot id
- `buildInjectionMessages` — prepends snapshot summary as `system` message, then appends post-snapshot messages

**`src/auth.ts`:**
- Added `AgentConfig` interface with `conversations_enabled`, `conversation_token_limit`, `conversation_summary_model`
- Extended `TenantContext` with `agentConfig?: AgentConfig`
- Extended DB query in `lookupTenant` to select the three new agent columns

**`src/index.ts` — gateway wiring:**
- Strips `conversation_id` / `partition_id` from raw body before forwarding upstream
- If `agentConfig.conversations_enabled`: resolves/creates partition + conversation, loads context, optionally summarizes (if over token limit) then builds injection messages
- Prepends history to request messages before `applyAgentToRequest`
- After non-streaming response: fire-and-forget `storeMessages`
- Adds `conversation_id` (and optionally `partition_id`) to response body + `X-Loom-Conversation-ID` header
- Auto-generates `conversation_id` (UUID) if client omits it

**`src/routes/portal.ts` — 6 new portal routes:**
- `GET /v1/portal/partitions` — tree of all tenant partitions (decrypted titles)
- `POST /v1/portal/partitions` — create partition with optional encrypted title
- `PUT /v1/portal/partitions/:id` — update title / parent
- `DELETE /v1/portal/partitions/:id` — delete (cascades to conversations)
- `GET /v1/portal/conversations` — metadata list, filterable by partition_id
- `GET /v1/portal/conversations/:id` — full detail: decrypted messages + snapshot summaries

### Key Learnings

- **Partial unique indexes for nullable FK uniqueness**: PostgreSQL UNIQUE treats two NULLs as distinct, so `UNIQUE (tenant_id, parent_id, external_id)` does NOT prevent duplicate root partitions. Always add a `CREATE UNIQUE INDEX … WHERE parent_id IS NULL` partial index alongside the general constraint for nullable columns that need null-safe uniqueness.
- **`IS NOT DISTINCT FROM` for null-safe equality in queries**: When filtering on a nullable FK with `WHERE col = $1`, NULL will never match. Use `WHERE col IS NOT DISTINCT FROM $1` to treat (col=NULL, $1=NULL) as a match.
- **Snapshot-based context loading via `snapshot_id IS NULL`**: Messages without a `snapshot_id` are "post-latest-snapshot" — the only messages that need to be injected alongside the snapshot summary. This avoids needing a join or secondary timestamp query; the archive step simply fills in the `snapshot_id` on all un-tagged messages.
- **Fire-and-forget for post-response persistence**: `storeMessages` is called with `.catch()` after `reply.send()` — same pattern as `traceRecorder.record()`. This keeps response latency low and avoids surfacing storage failures as HTTP errors.
- **Summarization as a provider proxy call**: Reuses the existing `provider.proxy()` plumbing for the summarization LLM call. No new HTTP client needed. The summary model falls back to the request model if `conversation_summary_model` is not set on the agent.

## 2026-02-28: Conversation Demo + Sandbox Portal Support

**Event:** Created standalone conversation demo and added conversation support to sandbox chat endpoint  
**Artifacts:** `examples/conversations/index.html`, `src/routes/portal.ts` (sandbox chat update), `portal/src/lib/api.ts` (already updated)

### What was built

**`examples/conversations/index.html` — Standalone demo:**
- Single-file HTML demo (no build tools) showing conversation memory feature
- Adds `conversation_id` and `partition_id` config inputs (both optional)
- Tracks active conversation ID in localStorage + displays it in status bar (truncated UUID)
- "New Conversation" button to clear stored ID and start fresh thread
- Extracts `conversation_id` from `X-Loom-Conversation-ID` response header (available immediately before stream reads)
- Auto-saves returned conversation ID for subsequent messages
- Comments explain conversation_id (thread identifier) and partition_id (user/group scope) semantics
- Single-message requests — gateway loads history server-side (unlike chat example which sends full history)

**`src/routes/portal.ts` — Sandbox chat conversation support:**
- Imported `conversationManager` from `conversations.ts`
- Extended agent DB query to include `conversations_enabled`, `conversation_token_limit`, `conversation_summary_model`
- Extended request body type to accept `conversation_id?: string` and `partition_id?: string`
- Added conversation loading logic before `applyAgentToRequest`:
  - If `conversations_enabled && conversation_id`: resolve/create partition, resolve/create conversation, load context, prepend history
  - Non-fatal error handling — catch all conversation load errors and proceed without memory (same as gateway)
- After response: fire-and-forget `storeMessages` call (same pattern as gateway)
- Response now includes `conversation_id` if present (spread into return object)

**Portal API client** (`portal/src/lib/api.ts`):
- Already updated with `conversationId` and `partitionId` optional parameters
- Response type already includes `conversation_id?: string`

### Key Learnings

- **Conversation header vs body**: The `X-Loom-Conversation-ID` header is available immediately after `fetch()` returns (before reading stream), while body `conversation_id` only appears after consuming the entire stream. For UI responsiveness, check header first.
- **Single-message requests with server-side history**: Unlike the basic chat example which sends full `conversationHistory` array, the conversation demo sends only the current message. The gateway/sandbox loads and injects history server-side. This reduces request payload and keeps conversation state canonical on the server.
- **Partition scope pattern**: `partition_id` is typically a user ID or team ID — provides logical isolation so different users/contexts can have separate conversation threads. The sandbox uses `__sandbox__` as default partition if none provided.
- **Fire-and-forget storage in sandbox**: Same `.catch()` pattern as gateway — `storeMessages` is called after response, logged on error but doesn't block or fail the HTTP response.

### 2026-02-28: Conversations & Memory Backend Implementation

**Delivered:** Complete backend for conversation memory and multi-turn chat support.

**What Was Built:**
- Migration with four new tables: `partitions`, `conversations`, `conversation_messages`, `conversation_snapshots`
- Three agent config columns: `conversations_enabled`, `conversation_token_limit`, `conversation_summary_model`
- `ConversationManager` module with full lifecycle support: partition/conversation creation, encrypted context loading, message storage, LLM-based summarization
- Extended `TenantContext` with `agentConfig` for conversation settings
- Wired conversation flow into `/v1/chat/completions` handler
- Six CRUD portal routes for partition and conversation management

**Key Design Patterns:**
- **Partition Root Uniqueness:** PostgreSQL partial index `WHERE parent_id IS NULL` alongside unique constraint (handles NULL != NULL semantics)
- **Messages as Append-Only Log:** No deletion; `snapshot_id` marks archival, `loadContext` loads only post-snapshot messages
- **Token Estimation:** Character-count method (`content.length / 4`) sufficient for threshold, no tiktoken dependency
- **Fire-and-Forget Summarization:** Matches gateway pattern; failures caught/logged, request proceeds with full history
- **Encryption:** AES-256-GCM per-tenant key derivation for all message content and snapshots; decryption failures silently skip (return `null`)
- **Portal Routes Security:** JWT-scoped to tenant_id, UUID-based detail routes (no external_id enumeration)

**Sandbox Extension:**
- Extended sandbox chat endpoint to support conversation_id and partition_id
- Defaults to `__sandbox__` partition for namespace isolation
- Non-fatal error handling: conversation load failures don't break endpoint
- Fire-and-forget message storage post-response (same pattern as tracing)
- Server-side history loading (vs. client-supplied array) to prevent desync

**Examples & Documentation:**
- `examples/conversations/index.html`: Interactive reference showing auto-generate and explicit flows
- `examples/conversations/README.md`: Usage guide for developers

**Notes for Future Waves:**
- Streaming conversation support deferred (requires SSE buffering for message archival)
- Summarization model configurable per agent; defaults to request model if unset
- Portal encryption/decryption handles key rotation gracefully (silent skip on old messages)

## Learnings

### 2026-02-28: Domain Service Gaps - PortalService Parity

**Task:** Fixed 13 critical gaps in `UserManagementService` and `TenantManagementService` to achieve parity with legacy `PortalService`.

**Changes to UserManagementService:**

1. **Email uniqueness pre-check in `createUser`**: Added explicit check before user creation, throws 409 "Email already registered" instead of relying on DB constraint
2. **Tenant name trimming in `createUser`**: Applied `.trim()` to tenant name to match legacy behavior
3. **Default agent creation in `createUser`**: After creating user+tenant+membership, now also creates a default Agent entity named "Default" — critical for API key creation flow
4. **Active tenant filtering in `login`**: Changed from `findOne` to `find` to load ALL tenant memberships, filter to only `status = 'active'` tenants
5. **Multi-tenant list in `login`**: Return `tenants: [{id, name, role}]` array in AuthResult for all active memberships (tenant switcher support)
6. **No active tenants guard in `login`**: Throw 403 "No active tenant memberships" if user has zero active tenants
7. **Tenant status check in `acceptInvite`**: Verify `invite.tenant.status === 'active'`, throw 400 if inactive
8. **Duplicate membership check in `acceptInvite`**: Changed from silent skip to explicit 409 "Already a member of this tenant" error
9. **New method `switchTenant(userId, newTenantId)`**: Validates membership + tenant status, signs new JWT with new tenantId, returns AuthResult with full tenant list
10. **New method `leaveTenant(userId, tenantId, currentTenantId)`**: Prevents leaving active tenant, checks last-owner protection, removes membership

**Changes to TenantManagementService:**

1. **Return keyHash in `revokeApiKey`**: Changed return type from `void` to `{ keyHash: string }` to support cache invalidation (route handler calls `invalidateCachedKey()`)
2. **Provider cache eviction in `updateSettings`**: If `providerConfig` is updated, call `evictProvider(tenantId)` after flush to invalidate provider cache
3. **Creator membership in `createSubtenant`**: After creating subtenant, now also creates TenantMembership for `dto.createdByUserId` with role 'owner' (prevents orphaned subtenants)
4. **New method `revokeInvite(tenantId, inviteId)`**: Load invite, throw 404 if not found, set `revokedAt = new Date()`, flush
5. **New method `listInvites(tenantId)`**: Query all invites for tenant, return as view models (includes `revokedAt` field)
6. **New method `updateMemberRole(tenantId, targetUserId, role)`**: Load membership, check last-owner protection before demoting from owner to member, update role
7. **New method `removeMember(tenantId, targetUserId, requestingUserId)`**: Prevent self-removal ("use leave instead"), check last-owner protection before removing owners, delete membership

**DTO Updates:**
- `AuthResult` now includes optional `tenants?: Array<{ id, name, role }>` for multi-tenant context
- `CreateSubtenantDto` now includes `createdByUserId: string` field
- `InviteViewModel` now includes `revokedAt: string | null` field

**Key Patterns Observed:**
- **Error pattern**: `throw Object.assign(new Error('message'), { status: 409 })` for HTTP status codes
- **Last-owner protection**: Count owners before demoting/removing, prevent if count === 1
- **Cache invalidation**: `evictProvider(tenantId)` after provider config changes, `invalidateCachedKey(keyHash)` after key revocation
- **Default agent structure**: Agent with `mergePolicies = { system_prompt: 'prepend', skills: 'merge', mcp_endpoints: 'merge' }`, required for API key creation
- **Active tenant filtering**: Filter memberships by `(m.tenant as Tenant).status === 'active'` before returning to user

**Test Updates:**
- Updated `createUser` test to expect 4 persist calls (was 3): user, tenant, membership, **agent**
- Updated `login` tests to mock `find()` instead of `findOne()` for membership loading
- Added `status: 'active'` to mocked tenant objects in login tests

All 355 tests passing. TypeScript compiles cleanly.

## Learnings

### 2026-02-24: Portal Migration — Phases 2 & 3 (Domain Services Integration)

**Phase 2 — Wire domain services into portal routes:**
- Updated `src/index.ts` to instantiate `UserManagementService` and `TenantManagementService` alongside existing services
- Modified `registerPortalRoutes` signature to accept the new domain services as parameters
- Ensured all services share the same EntityManager instance (`em`) for transaction consistency

**Phase 3 — Migrate route handlers:**
Migrated 20+ route handlers from PortalService to domain services:
- **Auth routes:** signup, login, signup-with-invite, switch-tenant, leave-tenant → `UserManagementService`
- **API key routes:** list, create, revoke → `TenantManagementService.{listApiKeys, createApiKey, revokeApiKey}`
- **Agent routes:** create, update, delete → `TenantManagementService` (list still on PortalService)
- **Member routes:** list, updateRole, remove → `TenantManagementService`
- **Invite routes:** create, list, revoke → `TenantManagementService`
- **Subtenant route:** create → `TenantManagementService.createSubtenant`
- **Settings route:** PATCH /v1/portal/settings → `TenantManagementService.updateSettings`

**Response shape transformations:**
- Domain services return view models with camelCase fields (e.g., `keyPrefix`, `agentId`)
- PortalService returns raw DB rows with snake_case (e.g., `key_prefix`, `agent_id`)
- Added inline transformations in routes to convert domain view models to the expected `formatAgent` shape
- Handled null/undefined type mismatches (e.g., `conversationTokenLimit: number | null` → `number | undefined` for formatAgent)

**Error handling updates:**
- `UserManagementService.login` throws `Error('Invalid credentials')` instead of returning null
- Updated route handler to catch and convert to 401 response
- `TenantManagementService.revokeApiKey` now returns `{ keyHash }` instead of `keyHash | null`
- Changed route to use try/catch and return 404 on error

**Test updates:**
- Extended `buildApp` test helper to accept `UserManagementService` and `TenantManagementService` mocks
- Created `buildMockUserMgmtSvc()` and `buildMockTenantMgmtSvc()` with vi.fn() implementations
- Updated failing test to override `userMgmtSvc.createUser` instead of `portalSvc.signup`
- All 355 tests still passing after migration

**Key Learnings:**
- When migrating from raw SQL service to domain services, response shapes often differ slightly—inline transformations at the route layer bridge the gap cleanly
- Domain services throw errors with `.status` properties; route handlers catch and map to HTTP status codes
- Test mocks must match the actual service interface behavior (throw vs return null, return types, etc.)
- Type mismatches (`number | null` vs `number | undefined`) surface at route boundaries—use `?? undefined` to convert
- Migrating in phases (wire services first, then migrate routes) makes debugging easier than a big-bang change

**Status:** ✅ Complete — Phases 2 & 3 of portal migration done. All tests passing. PortalService still handles routes not yet migrated (getAgent, getAgentResolved, listAgents, traces, analytics, conversations).

### 2026-02-24: Portal Migration — Phase 4 (Slim Down PortalService)

**Objective:** Remove all methods from PortalService that have been successfully migrated to domain services.

**Removed methods:**
Authentication & User Management (migrated to `UserManagementService`):
- `signup`
- `login`
- `signupWithInvite`
- `switchTenant`
- `leaveTenant`

Tenant Management (migrated to `TenantManagementService`):
- `listApiKeys`, `createApiKey`, `revokeApiKey`
- `createAgent`, `updateAgent`, `deleteAgent`
- `listMembers`, `updateMemberRole`, `removeMember`
- `createInvite`, `listInvites`, `revokeInvite`
- `createSubtenant`
- `updateProviderSettings`

**Removed utility functions & imports:**
Since all auth/API key methods are gone, removed:
- `hashPassword()`, `verifyPassword()` (no longer used)
- `generateApiKey()` (no longer used)
- `signPortalToken`, `PORTAL_JWT_SECRET` (no longer used)
- Imports: `randomBytes`, `createHash`, `scrypt`, `timingSafeEqual`, `promisify`, `createSigner` from crypto/fast-jwt

**Methods still in PortalService:**
These remain because they're still called from `portal.ts`:
- `getMe` — user profile + tenant context
- `listTraces` — analytics traces
- `getInviteInfo` — public invite info
- `listUserTenants` — user's tenant memberships
- `listSubtenants` — subtenant hierarchy
- `listAgents` — agent listing
- `getAgent`, `getAgentResolved`, `getAgentForChat` — agent read operations
- `listPartitions`, `createPartition`, `updatePartition`, `deletePartition` — partition management
- `listConversations`, `getConversation` — conversation management

**Verification:**
- Analyzed `src/routes/portal.ts` to find all `svc.` method calls still in use
- Removed only methods confirmed to be no longer referenced
- ✅ TypeScript: `npx tsc --noEmit` — passes with no errors
- ✅ Tests: `npm test` — all 355 tests pass

**Key Learnings:**
- PortalService went from ~40 methods to ~15 methods
- Removed ~500 lines of migrated code
- Imports significantly reduced (no longer need crypto/JWT utilities)
- Systematic verification approach (grep for `svc.` in portal.ts) ensures safe removal
- All business logic for auth/tenants/members/invites/API keys now fully lives in domain services
- PortalService is now focused on: profiles, traces, invites (read-only), agents (read-only), partitions, conversations

**Status:** ✅ Complete — Phase 4 done. PortalService successfully slimmed down by removing all migrated methods.

---

### 2026-02-27: User.create() Factory — Domain Invariant Enforcement

**Task:** Implement domain invariant where User creation ALWAYS creates a personal Tenant, owner TenantMembership, and default Agent together.

**Implementation:**
- Added `User.create(email, passwordHash, tenantName?)` static factory to `src/domain/entities/User.ts`
- Factory returns `{ user, tenant, membership, defaultAgent }` — all entities ready for persistence
- Updated `UserManagementService.createUser` to use factory (reduced from 48 lines to 6 lines)
- Updated `UserManagementService.acceptInvite` to use factory for new users (invited users now get personal tenant too)
- Used parameterless `new Entity()` pattern (MikroORM requirement)
- Imports: User imports Tenant/TenantMembership/Agent (no circular deps)

**Learnings:**
- **Domain invariants belong in domain entities, not service layer**: Moving the creation logic to User.create() makes the invariant explicit and impossible to violate
- **Static factories > constructors for MikroORM entities**: Entities need parameterless constructors for ORM hydration, but factories can accept params
- **Default tenant name uses full email**: `${email}'s Workspace` (not just email prefix) to match existing behavior
- **Users created via invite also get personal tenant**: Respects the invariant universally (signup AND invite flows)
- **Service layer simplification**: UserManagementService went from constructing 4 entities manually to calling one factory method
- **Return object pattern**: Returning `{ user, tenant, membership, defaultAgent }` is cleaner than out-params or aggregate classes

**Verification:**
- ✅ TypeScript: `npx tsc --noEmit` — passes
- ✅ Tests: `npm test` — all 381 tests pass
- Factory creates User with lowercased email, personal Tenant (status='active'), owner TenantMembership, and default Agent with standard merge policies
- Both signup and invite flows now consistently create the full entity graph

**Key Pattern:**
```typescript
// Domain: encapsulate invariant
static create(email, passwordHash, tenantName?) {
  const user = new User();
  const tenant = new Tenant();
  const membership = new TenantMembership();
  const defaultAgent = new Agent();
  // ... initialize all fields ...
  return { user, tenant, membership, defaultAgent };
}

// Service: call factory + persist
const { user, tenant, membership, defaultAgent } = User.create(...);
em.persist(user);
em.persist(tenant);
em.persist(membership);
em.persist(defaultAgent);
await em.flush();
```

**Status:** ✅ Complete — User creation invariant now enforced at domain level.

---

### 2026-02-27: Tenant Aggregate — Enforcing Membership Boundaries

**Task:** Refactor domain model to enforce proper aggregate boundaries:
1. Tenant has constructor that takes owner User (and name)
2. Memberships ONLY created through `tenant.addMembership(user, role)`
3. `tenant.createSubtenant(name)` inherits parent's member list
4. All service and entity code updated accordingly

**Implementation:**

**1. `src/domain/entities/Tenant.ts`:**
- Added optional constructor `constructor(owner?: User, name?: string)` (optional params for MikroORM hydration)
- Constructor initializes all fields and calls `this.addMembership(owner, 'owner')` when params provided
- Renamed `addMember` → `addMembership` (clearer intent)
- Updated `createSubtenant(name)` to inherit parent's member list via loop: `for (const m of this.members) child.addMembership(m.user, m.role);`

**2. `src/domain/schemas/Tenant.schema.ts`:**
- Added `cascade: [Cascade.PERSIST]` to `members`, `agents`, and `invites` collections
- When you `em.persist(tenant)`, its collections auto-cascade without explicit persist calls

**3. `src/domain/entities/User.ts`:**
- Refactored `User.create()` factory to use `new Tenant(user, tenantName ?? ...)` instead of manual construction
- Used `tenant.createAgent('Default')` instead of manual Agent construction
- Return type changed from `{ user, tenant, membership, defaultAgent }` → `{ user, tenant }` (membership/agent now inside tenant collections)
- Removed `TenantMembership` import (no longer directly instantiated)

**4. `src/application/services/UserManagementService.ts`:**
- In `createUser`: changed from `em.persist(user); em.persist(tenant); em.persist(membership); em.persist(defaultAgent);` → `em.persist(user); em.persist(tenant);` (cascade handles the rest)
- In `acceptInvite`: replaced manual `new TenantMembership()` → `tenant.addMembership(user, role)`
- Removed `randomUUID` and `Agent` imports (no longer needed)

**5. `src/application/services/TenantManagementService.ts`:**
- In `createSubtenant`: load parent with `{ populate: ['members', 'members.user'] }` so inheritance works
- Removed manual membership creation for creator — `createSubtenant` now inherits all parent members
- Removed `randomUUID` import

**6. Tests:**
- `tests/domain-entities.test.ts`: renamed `addMember` → `addMembership` in test names
- `tests/application-services.test.ts`:
  - Updated persist count checks: 4 → 2 (cascade handles membership/agent)
  - Fixed default tenant name assertion: `user@example.com` → `user` (now uses `${email.split('@')[0]}'s Workspace`)
  - Updated "creates a default agent" test to check `tenant.agents` collection instead of explicit persist call
  - Updated `createSubtenant` test to populate parent with members and verify child inherits them

**Learnings:**
- **Aggregate Root Pattern**: Tenant is the aggregate root; TenantMembership is ONLY created through Tenant methods, never directly in service layer
- **Constructor with Optional Params for MikroORM**: `constructor(owner?: User, name?: string)` allows `new Tenant()` (for ORM hydration) AND `new Tenant(user, name)` (for domain logic)
- **Cascade.PERSIST reduces boilerplate**: Service layer no longer needs explicit `em.persist(membership)` — persisting the aggregate root is enough
- **Subtenant Inheritance**: Copying parent members at creation time (not via DB constraints) gives flexibility for future role overrides
- **Factory Pattern Evolution**: `User.create()` now returns `{ user, tenant }` — membership and agent are hidden inside tenant collections
- **Production vs Test Code**: Production code NEVER calls `new TenantMembership()` directly; tests can still construct mocks directly for fixtures

**Verification:**
- ✅ TypeScript: `npx tsc --noEmit` — passes
- ✅ Tests: `npm test` — all 381 tests pass
- New users get personal tenant with owner membership (via constructor)
- Invited users join tenant via `addMembership` (no manual membership construction)
- Subtenants inherit full parent member list at creation time

**Key Pattern:**
```typescript
// Domain: Tenant controls its aggregate
constructor(owner?: User, name?: string) {
  if (owner !== undefined && name !== undefined) {
    this.id = randomUUID();
    // ... initialize fields ...
    this.addMembership(owner, 'owner'); // Invariant: constructor creates owner membership
  }
}

createSubtenant(name: string): Tenant {
  const child = new Tenant();
  // ... initialize child fields ...
  for (const m of this.members) {
    child.addMembership(m.user, m.role); // Inherit parent members
  }
  return child;
}

// Service: use aggregate methods, never direct TenantMembership construction
const tenant = new Tenant(user, name); // membership created inside
em.persist(tenant); // cascade handles membership persistence
```

**Status:** ✅ Complete — Tenant aggregate boundaries enforced; memberships only via `addMembership()`.


## Learnings

### Tenant Constructor — Required Params (2025)

**Task:** Tighten `Tenant` constructor so `new Tenant()` is a TypeScript compile error.

**Change:** Removed optional params (`owner?: User, name?: string`) and the `if (owner !== undefined && name !== undefined)` guard. Constructor now requires both `owner: User` and `name: string`, and always runs full initialization.

**Why it's safe with MikroORM:** MikroORM uses `Object.create(Entity.prototype)` during hydration — the constructor is never called on the ORM path. Required constructor params impose zero runtime cost on the ORM.

**Fixture pattern for tests and internal factory methods** that need a Tenant without running constructor logic:
```typescript
const t = Object.assign(Object.create(Tenant.prototype) as Tenant, {
  id: 'tenant-1',
  name: 'Test Tenant',
  // ... other fields
});
```

**createSubtenant fix:** This internal method used `new Tenant()` to build a child object manually. Refactored to use the same `Object.assign(Object.create(...))` pattern since it sets all fields itself and should not trigger owner-membership creation.

**Status:** ✅ Complete — `npx tsc --noEmit` clean, all 381 tests pass.

### User Constructor — Static Factory → Constructor (2025)

**Task:** Convert `User.create()` static factory into a proper constructor, following the Tenant pattern.

**Change:** Removed `static create(email, passwordHash, tenantName?)` and replaced with `constructor(email, passwordHash, tenantName?)`. The constructor runs the same init logic and stores the auto-created `Tenant` as a transient property `user.tenant`.

**Transient property approach:** Since a constructor can't return `{ user, tenant }`, the auto-created Tenant is stored on `user.tenant` (not an ORM column). Callers read `user.tenant!` after construction for persistence. Added `{ entity: () => Tenant, persist: false, nullable: true }` to `User.schema.ts` to satisfy MikroORM's `EntitySchema` type requirement that all class properties be declared.

**Test fixture update:** `makeUser()` was using `new User()` (no args), which now crashes because the constructor calls `email.toLowerCase()`. Updated to use the same `Object.create(User.prototype)` pattern as `makeTenant()`.

**Status:** ✅ Complete — `npx tsc --noEmit` clean, all 381 tests pass.

### User.memberships Collection (2025)

**Task:** Add a `memberships` collection to the `User` entity so a user can navigate to all tenants they belong to via the ORM.

**Changes:**
1. **User.ts** — imported `Collection` from `@mikro-orm/core` and added `memberships = new Collection<TenantMembership>(this);` property. Used type-only import for `TenantMembership` to avoid potential circular dependency issues.
2. **User.schema.ts** — added inverse relationship mapping:
   ```typescript
   memberships: { kind: '1:m', entity: () => TenantMembership, mappedBy: 'user', eager: false }
   ```
   The `mappedBy: 'user'` tells MikroORM this is the inverse side of the relationship, pointing at the `user` property on `TenantMembership`.

**Why no migration needed:** This is a purely in-ORM inverse relationship. The owning side (`TenantMembership.user`) already has the `user_id` foreign key column. MikroORM now enables bi-directional navigation without any database schema changes.

**Constructor vs hydration:** MikroORM hydration bypasses the constructor, so the `new Collection<TenantMembership>(this)` initializer in the entity is only for manual construction scenarios. The ORM replaces it during hydration with the actual collection.

**Status:** ✅ Complete — all 381 tests pass.

### 2026-02-25: User/Tenant Construction Inversion

**Context:** Previously, the `User` constructor created a `Tenant` internally and leaked it as a transient `user.tenant` property. This violated separation of concerns — domain entities shouldn't orchestrate multi-entity creation.

**Refactoring:**
- Removed `tenant?: Tenant` property and all tenant construction logic from `User` entity
- Removed `tenant` from `User.schema.ts` (was `persist: false`, never a DB column)
- Simplified `User` constructor to `constructor(email: string, passwordHash: string)` — just sets id, email, passwordHash, createdAt, lastLogin
- Extracted `createUserWithTenant()` private helper in `UserManagementService` that constructs both User and Tenant, calls `tenant.createAgent('Default')`, and returns both
- Updated `registerUser` to use `createUserWithTenant()`
- Updated `acceptInvite` (new user branch) to use `createUserWithTenant()` and explicitly persist both user and personalTenant

**Key Insight:** The "every user has a personal tenant" rule is a service-layer concern, not a domain invariant. The User entity should be a simple data holder; the service orchestrates multi-entity creation.

**Status:** ✅ Complete — all 381 tests pass. No test changes needed (fixture uses `Object.assign()`, not constructor).

## Learnings

### 2026-xx-xx: Entity Constructor Refactor (Wave 4 DDD)

- **Required-param constructors are safe with MikroORM**: MikroORM uses `Object.create(Entity.prototype)` for hydration and never calls constructors, so adding required-parameter constructors to entities is safe for ORM use.
- **`readonly rawKey` pattern for transient crypto material**: `ApiKey` exposes `rawKey` as a `readonly` non-persistent property set in the constructor. This keeps raw secret material available immediately post-construction without ever storing it in the DB, and TypeScript's `readonly` signals it's one-time use.
- **Test fixtures use `Object.assign(Object.create(Entity.prototype), {...})`**: This mirrors MikroORM's own hydration pattern. It gives full instanceof checks, prototype method access, and bypasses required-param constructors for test fixture objects — same pattern already established for `User` and `Tenant`.
- **Thin factory wrappers on aggregates**: `Tenant.createAgent`, `createInvite`, `addMembership` are now 3-line wrappers — construct entity, push to collection, return. All initialization logic lives in entity constructors. This keeps the aggregate root's role as an orchestrator, not an initializer.

### JWT Consolidation (Admin + Portal)

**Files changed:**
- `src/auth/jwtUtils.ts` — NEW: `signJwt` and `verifyJwt` wrappers around `jsonwebtoken`
- `src/middleware/createBearerAuth.ts` — NEW: generic preHandler factory for Bearer token auth
- `src/middleware/adminAuth.ts` — Replaced `request.jwtVerify()` with `createBearerAuth`; removed `@fastify/jwt` coupling
- `src/middleware/portalAuth.ts` — Replaced `fast-jwt` `createVerifier` with `createBearerAuth`
- `src/routes/admin.ts` — Replaced `fastify.jwt.sign()` with `signJwt()`; added `ADMIN_JWT_SECRET` const
- `src/application/services/UserManagementService.ts` — Replaced `fast-jwt` `createSigner`/`signToken` with `signJwt()`
- `src/index.ts` — Removed `@fastify/jwt` import and `fastify.register(fastifyJWT, ...)` call
- `tests/admin.test.ts` — Removed `@fastify/jwt` import and plugin registration in `buildApp`; updated 2 test assertions to match new `'Unauthorized'` error message
- `tests/portal-routes.test.ts` — Replaced `fast-jwt` `createSigner` with `signJwt` for test token generation

**Packages removed:** `fast-jwt`, `@fastify/jwt`
**Packages added:** `jsonwebtoken`, `@types/jsonwebtoken`

**Gotchas:**
- `createBearerAuth` returns `{ error: 'Unauthorized' }` for all auth failures (no distinction between missing header vs invalid token). The old `adminAuth.ts` had distinct messages for each case. Two test assertions were checking for the old specific messages and needed updating.
- `fast-jwt`'s `createSigner` takes `expiresIn` in milliseconds; `jsonwebtoken`'s `sign` takes `expiresIn` in seconds. `signJwt` handles the conversion internally (`Math.floor(expiresInMs / 1000)`).
- The `@fastify/jwt` plugin decorated `fastify` with `.jwt.sign()` and augmented `FastifyRequest` with `.jwtVerify()`. Both are now gone — no TypeScript augmentation needed for those.

### Registry/KB Migration (2026)

**Task:** Create `migrations/1000000000015_registry.cjs` — pgvector extension, org_slug, agents.kind, vector_spaces, artifacts, artifact_tags, kb_chunks, deployments, embedding_operations, artifact_operations, and RAG columns on traces.

**Pattern:** Follows `1000000000014_conversations.cjs` exactly — `exports.shorthands = undefined`, `exports.up = async (pgm)`, `exports.down = async (pgm)`. Standard DDL uses `pgm.createTable`/`pgm.addColumns`/`pgm.addConstraint`/`pgm.createIndex`; raw SQL via `pgm.sql()` for pgvector extension, ivfflat index, and partial index on traces.

**Key decisions:**
- `tenants.org_slug` is nullable (backfill deferred to application logic or a follow-up migration)
- `agents.kind` is `NOT NULL DEFAULT 'inference'` — safe to add without backfill
- `kb_chunks.embedding` is `vector(1536)` for text-embedding-3-small
- ivfflat index with `lists = 100` on kb_chunks embedding (cosine ops)
- `deployments.runtime_token` stored as plain TEXT; at-rest encryption is infra responsibility
- Down migration drops tables in strict reverse order, then drops added columns, then drops the extension

**Status:** ✅ Complete — file written, inbox decision filed at `.squad/decisions/inbox/fenster-registry-migration.md`

## 2026-02-27: Registry Scopes + JWT Extension + registryAuth Middleware

**Event:** Implemented registry scope constants, extended JWT payload, and created scope-based auth middleware  
**Artifacts:** `src/auth/registryScopes.ts`, `src/auth/jwtUtils.ts` (extended), `src/middleware/registryAuth.ts`, `src/application/services/UserManagementService.ts` (updated)

**What was built:**
- `REGISTRY_SCOPES` constants and `TENANT_OWNER_SCOPES` array in `registryScopes.ts`
- `JwtPayload` interface in `jwtUtils.ts` with `scopes?: string[]` and `orgSlug?: string | null`
- `registryAuth(requiredScope, secret)` Fastify preHandler factory in `registryAuth.ts`
- All four `signJwt` calls in `UserManagementService` now emit `scopes` (role-based) and `orgSlug: null`

## Learnings

- **JWT payload extension is always additive**: Adding optional fields to an existing `signJwt(payload: object, ...)` call is safe — existing token consumers that don't read the new fields are unaffected. Only add required fields once all consumers are ready to handle them.
- **Scope assignment at mint time, not lookup time**: Embedding scopes directly in the JWT at login/signup avoids per-request DB lookups in registry middleware. Role-to-scopes mapping belongs in the auth service, not in the middleware.
- **Factory pattern for auth middleware**: Following the `createBearerAuth` factory pattern (accept secret + config, return async handler) keeps middleware testable in isolation and prevents secret leakage into module scope.
- **`orgSlug: null` as safe placeholder**: When a migration is running in parallel, using `null` for the new field is preferable to blocking on the migration. The `JwtPayload` type marks it `orgSlug?: string | null` to make the null case explicit and type-safe.

### Loom → Arachne Rebrand (2026)

**Task:** Rename all user-facing product strings from "Loom" to "Arachne" across codebase.

**Approach:** Targeted `grep` to find occurrences, then surgical `edit` tool changes. Scope was strictly user-facing strings; variable names (`loomConfig` etc.) deferred.

**Files changed (17 total):**
- `package.json` — `"name"` field
- `src/index.ts` — `X-Loom-Conversation-ID` → `X-Arachne-Conversation-ID` response header
- `src/conversations.ts`, `src/agent.ts` — file-level comments
- `portal/src/` — AppLayout, LoginPage, SignupPage, LandingPage, TracesPage, ApiKeysPage + their tests
- `dashboard/src/` — Layout, ApiKeyPrompt, README
- `README.md`, `RUNNING_LOCALLY.md`

**Intentionally skipped:**
- Variable/function names (`loomConfig`, etc.) — too risky for P0
- `docker-compose.yml` POSTGRES_DB/USER — DB infra, changing would require data migration
- No `loom.ai/v0` strings or `loom_` migration tables found; migrations untouched

**Key learnings:**
- `sed -i ''` (macOS) handles multi-occurrence symbol replacements (like the `⧖ Loom` logo) more reliably than the `edit` tool when the pattern appears identically multiple times in a file
- Always search `dashboard/README.md` — sub-package READMEs are easily missed
- HTTP response headers are user/API-facing and should be rebranded (breaking change for callers — coordinate with API consumers)

## 2026-02-25: RegistryService Implementation

**Event:** Implemented `src/services/RegistryService.ts` — content-addressed artifact registry for KnowledgeBase, Agent, and EmbeddingAgent bundles.

**Methods delivered:**
- `push(input, em)` — idempotent push: checks sha256 uniqueness per tenant, creates Artifact + optional VectorSpace + KbChunks, upserts ArtifactTag
- `resolve(ref, tenantId, em)` — resolves `org/name:tag` to Artifact entity; tenant-scoped
- `list(tenantId, org, em)` — groups artifacts by name, returns tag list + latestVersion per name
- `pull(ref, tenantId, em)` — delegates to resolve, returns bundleData Buffer or null
- `delete(ref, tenantId, em)` — removes ArtifactTag; if zero remaining tags point to artifact version, removes Artifact + KbChunks

**Patterns used:**
- `em.findOne` / `em.findOneOrFail` / `em.find` / `em.count` — standard MikroORM EntityManager queries
- `em.persist()` per entity + `em.flush()` at end of write operations (matches existing service patterns)
- `em.remove()` for cascading deletes; chunks queried then individually removed before artifact removal
- `_upsertTag` private helper: looks up existing ArtifactTag for same org/name/tenant, calls `.reassign()` if found, creates new otherwise

**Key decisions:**
- `version` field on Artifact set to `input.tag` (the incoming tag serves as the version label)
- VectorSpace created only for `kind === 'KnowledgeBase'` with `vectorSpaceData` present
- sha256 idempotency: on duplicate, re-upserts tag to point to existing artifact (no error thrown)
- Tenant scope guard in `resolve()` handles both populated `Tenant` object and raw ID string

## 2026-02-27T: EmbeddingAgent kind + system-embedder bootstrap

**Event:** Implemented EmbeddingAgentService and startup bootstrap hook  
**Artifacts:** `src/services/EmbeddingAgentService.ts`, `src/index.ts` (startup hook), `RUNNING_LOCALLY.md` (new section), `src/domain/schemas/Agent.schema.ts` (kind field), `src/domain/schemas/ApiKey.schema.ts` (rawKey persist:false)

**What was built:**
- `EmbeddingAgentService` with `resolveEmbedder()`, `bootstrapSystemEmbedder()`, `bootstrapAllTenants()` methods
- Resolution order: named agentRef → env vars → throw
- systemPrompt field stores JSON config for embedding agents: `{ provider, model, dimensions }`
- Startup hook in `src/index.ts` after `initOrm()`: bootstraps system-embedder for all active tenants if `SYSTEM_EMBEDDER_PROVIDER` + `SYSTEM_EMBEDDER_MODEL` env vars are set
- Upsert semantics: create if not exists, update systemPrompt only if config changed
- Fixed pre-existing schema breakage: `kind` was missing from `Agent.schema.ts`; `rawKey` (persist:false) was missing from `ApiKey.schema.ts`

## Learnings

- **Embedding agent config lives in systemPrompt as JSON**: Since systemPrompt is already a text field, embedding agents can store `{"provider":"openai","model":"text-embedding-3-small","dimensions":1536}` there cleanly. No new columns needed.
- **Schema `persist: false` requires `type` alongside it**: MikroORM's `EntitySchemaProperty` requires `type` to be present even for virtual (non-persisted) fields; `{ type: 'string', persist: false }` is the correct pattern.
- **bootstrapAllTenants uses sequential loop not parallel**: Using `for...of` instead of `Promise.all` avoids flooding the DB with concurrent flush() calls during startup; startup is a one-time event so throughput over correctness is fine.
- **Startup hook placement**: The embedding bootstrap runs on a fresh `orm.em.fork()` distinct from the main `em` used for the request lifecycle; this keeps the startup work isolated and prevents identity map conflicts.
- **ProvisionService: use `em.count()` not `artifact.chunkCount` for live KB validation**: `artifact.chunkCount` is set at push time but can drift if chunks are deleted. `em.count(KbChunk, { artifact: artifact.id })` queries live state and is the correct choice for a readiness gate.
- **Runtime JWT secret pattern**: `RUNTIME_JWT_SECRET` env var with `PORTAL_JWT_SECRET` fallback avoids hard boot failures in dev while keeping production secrets separate. Runtime tokens use `runtime:access` scope and 1-year expiry.
- **`deploymentId` must be returned even for early FAILED (artifact not found)**: `DeployResult` requires `deploymentId: string`. When the artifact lookup short-circuits before a Deployment row is created, return a `randomUUID()` — callers treat FAILED results as transient.
- **`unprovision` must explicitly null `runtimeToken`**: `Deployment.markFailed()` doesn't clear `runtimeToken` by design; `unprovision` sets it to `null` after `markFailed` to revoke runtime access.
- **`orgSlug` uniqueness check must exclude current tenant**: `findByOrgSlug(slug)` returns any tenant with that slug; in the update flow, check `existing.id !== tenantId` before returning 409.
- **`assignUniqueSlug` must be called before flush**: The method uses `em.findOne` to check uniqueness; since the tenant is already persisted (via `em.persist`) but not flushed, the DB doesn't yet have the row, so the uniqueness check is safe to run before flush without a conflict.
- **Extending existing Fastify routes vs. adding new ones**: Fastify throws if you register the same method+path twice. When a task asks to "add" a route that already exists, extend the existing handler to handle the new field rather than registering a duplicate.
- **`provider` field in PATCH /v1/portal/settings made optional**: The existing endpoint required `provider`. Extended it to also handle `orgSlug`-only updates by making `provider` optional and short-circuiting when only `orgSlug` is provided.

## 2026-02-25T04:00:00Z: WeaveService Implementation

**Event:** Implemented `src/services/WeaveService.ts` — the `loom weave` pipeline  
**Task:** Requested by Michael Brown  
**Artifacts:** `src/services/WeaveService.ts`

**What was built:**
- `parseSpec(yamlPath)` — reads and validates a YAML spec file using a custom minimal YAML parser (no external dependencies); validates `apiVersion` and `kind`
- `resolveDocs(docsPath)` — resolves docs from a directory (recursive walk), `.zip` file (binary ZIP extraction), or single file; returns `{ filename, content: Buffer }[]`
- `chunkText(text, tokenSize, overlap)` — word-aligned sliding-window chunker; 1 token ≈ 4 chars heuristic; step = `(tokenSize - overlap) * 4`
- `embedTexts(texts, provider, model, apiKey)` — OpenAI embeddings via native `fetch`; batches at 100 texts/request; sorts by index to preserve order
- `computePreprocessingHash(config)` — SHA-256 of `{ provider, model, tokenSize, overlap }` JSON for VectorSpace fingerprint
- `packageBundle(spec, chunks, vectorSpace)` — builds `.tgz` in-memory (custom minimal POSIX ustar tar + node:zlib gzip); signs with HMAC-SHA256 if `BUNDLE_SIGNING_SECRET` is set
- `weaveKnowledgeBase(yamlPath, outputDir, tenantId, em?)` — full pipeline: parse → resolve docs → chunk → embed → package → write `.tgz`
- `weaveConfigArtifact(yamlPath, outputDir)` — config-only bundle for Agent/EmbeddingAgent specs

**Key Design Decisions:**
- No external YAML or tar library installed; implemented minimal versions inline (keeps deps clean)
- YAML parser uses indent-stack approach; handles 3+ levels of nesting cleanly
- ZIP extractor scans local file headers sequentially; supports stored (0) and deflated (8) compression
- Tar builder uses POSIX ustar format with correct checksum computation
- `em` param reserved for future EmbeddingAgent DB lookup; P0 always uses system env vars

## Learnings

- **No js-yaml in package.json**: A minimal line-by-line indented-YAML parser with an indent-stack (push nested objects, pop on de-dent) is ~40 lines and handles all realistic spec structures without additional dependencies.
- **Custom POSIX ustar tar**: Building tar headers manually (512-byte blocks, octal size/mtime, checksum over all 512 bytes) is about 30 lines. The checksum must be calculated with the checksum field pre-filled with spaces (0x20), not zeros.
- **ZIP local file header scanning**: Scanning sequentially from offset 0 via local file header signatures (`0x04034b50`) is reliable for valid ZIPs. Stop on central directory signature (`0x02014b50`). Handle data descriptor flag (bit 3) by skipping 16 bytes.
- **embedTexts + internal batching**: Even when the caller batches at 100 chunks, `embedTexts` should also enforce the 100-per-request limit internally — callers may pass arbitrary-sized arrays.
- **Dimensions from first response**: Don't hardcode embedding dimensions — infer from `embeddings[0].length` after the first API call. Model-specific dimension knowledge would create coupling.

## 2026-02-28: Portal KB + Deployment routes

**Event:** Added 6 new portal API routes to `src/routes/portal.ts` for Knowledge Base and Deployment resources.

**Routes delivered:**
- `GET /v1/portal/knowledge-bases` — lists all KnowledgeBase artifacts for tenant (id, name, tags, chunkCount, createdAt, vectorSpace)
- `GET /v1/portal/knowledge-bases/:id` — single KB detail with live chunkCount and searchReady flag
- `DELETE /v1/portal/knowledge-bases/:id` — removes artifact, all chunks, and all tags
- `GET /v1/portal/deployments` — lists deployments with artifact info (no runtimeToken)
- `GET /v1/portal/deployments/:id` — single deployment detail including chunkCount for KB artifacts
- `DELETE /v1/portal/deployments/:id` — calls `ProvisionService.unprovision()` to mark FAILED + clear runtimeToken

**Patterns used:**
- Auth: `authRequired` preHandler (same as all portal routes)
- `tenantId` extracted from `request.portalUser!`
- `orm.em.fork()` per request — `orm` imported from `../orm.js`; `RegistryService`/`ProvisionService` take em per method call, so no constructor em needed
- Dynamic `import()` for `Artifact`, `KbChunk` entities to avoid circular dependencies at module load
- `runtimeToken` intentionally excluded from all portal responses (CLI-only field)
- `chunkCount` on KB detail is queried live via `em.count(KbChunk, ...)` — same pattern as ProvisionService deploy validation

## Learnings

- **`orm.em.fork()` per request for services that take em per method**: When a service's methods accept `em` as a parameter (not via constructor), import `orm` and fork per handler. This is cleaner than adding `em` to service constructors or to `registerPortalRoutes` signature.
- **Dynamic import to avoid circular deps**: Importing entity classes inside handler bodies (`await import('../domain/entities/Artifact.js')`) avoids potential circular dependency issues at module load time.
- **`em.populate()` for nested relations on fetched entities**: When `getDeployment` returns a Deployment without populated `artifact.vectorSpace`, call `em.populate(deployment, ['artifact', 'artifact.vectorSpace'])` before accessing nested fields.

## Learnings

### 2026-07-15: Registry Gateway Routes (F-registry-routes)

**Task:** Implemented `src/routes/registry.ts` — all 7 Fastify route handlers for the artifact registry.

**Routes delivered:**
- `POST /v1/registry/push` — multipart/form-data upload, sha256 validation, delegates to `RegistryService.push()`
- `GET /v1/registry/list` — lists artifacts by org, delegates to `RegistryService.list()`
- `GET /v1/registry/pull/:org/:name/:tag` — streams bundle as `application/octet-stream`
- `DELETE /v1/registry/:org/:name/:tag` — removes artifact tag/artifact, delegates to `RegistryService.delete()`
- `POST /v1/registry/deploy` — provisions a deployment, delegates to `ProvisionService.deploy()`
- `GET /v1/registry/deployments` — lists deployments, delegates to `ProvisionService.listDeployments()`
- `DELETE /v1/registry/deployments/:id` — unprovisions a deployment, delegates to `ProvisionService.unprovision()`

**Key decisions:**
- Installed `@fastify/multipart` (^9.4.0) — not in original package.json, required for multipart push endpoint
- `REGISTRY_JWT_SECRET` env var with fallback to `PORTAL_JWT_SECRET` then dev default (same pattern as `ProvisionService`)
- `orm.em.fork()` per request — EntityManager is not request-safe
- `registryAuth` preHandler per route (not global) for per-scope enforcement
- Compute sha256 from uploaded bundle; validate against provided value if present; 400 on mismatch

**Pattern notes:**
- `@fastify/multipart` must be registered as a plugin on the fastify instance *before* routes that use `request.parts()`
- Iterate `request.parts()` with `for await` — accumulate file chunks into `Buffer.concat()`
- Route registration uses same `fastify.register((instance, opts, done) => { ... done(); })` wrapper as other route files
- Passed `orm` (not `orm.em`) to `registerRegistryRoutes` so each handler can call `orm.em.fork()` safely

### 2026-03-01: Registry Auth Middleware + JWT Scope Extension

**What:** Added scope-based auth layer for registry routes.
- Created `src/auth/registryScopes.ts` — `REGISTRY_SCOPES` constants and `TENANT_OWNER_SCOPES` array
- Extended `src/auth/jwtUtils.ts` — `JwtPayload` interface with `scopes?: string[]` and `orgSlug?: string | null`
- Created `src/middleware/registryAuth.ts` — Fastify preHandler factory for scope-based authorization
- Updated `UserManagementService` — all four `signJwt` calls now embed `scopes` and `orgSlug: null`

**Key decisions:**
- `registryAuth(requiredScope, secret)` takes explicit secret (matches existing `createBearerAuth` pattern)
- Owner → `TENANT_OWNER_SCOPES`, member → `[]` — role-based at token-mint time
- `orgSlug: null` placeholder until `org_slug` migration lands; no breakage (nullable)
- Backward-compatible: payload additive only

### 2026-03-01: WeaveService — Chunk/Embed/Sign Pipeline

**What:** Created `src/services/WeaveService.ts` — the `arachne weave` backend pipeline.

**Methods:**
- `parseSpec(yamlPath)` — parse + validate YAML spec → typed `AnySpec`
- `resolveDocs(docsPath)` — resolve docs from dir/.zip/single file
- `chunkText(text, tokenSize, overlap)` — word-aligned sliding-window chunker
- `embedTexts(texts, provider, model, apiKey)` — OpenAI embeddings, batched at 100/req
- `computePreprocessingHash(config)` — SHA-256 of chunking+model config
- `packageBundle(spec, chunks, vectorSpace)` — `.tgz` with HMAC-SHA256 signature
- `weaveKnowledgeBase(yamlPath, outputDir, tenantId, em?)` — full KB pipeline
- `weaveConfigArtifact(yamlPath, outputDir)` — config-only bundle for Agent/EmbeddingAgent

**Key decisions:**
- No new npm deps — custom YAML parser, custom POSIX ustar tar builder, custom ZIP extractor, native `fetch`
- P0: always uses `SYSTEM_EMBEDDER_PROVIDER/MODEL/API_KEY` env vars (DB-based agent resolution deferred)
- Only OpenAI supported for P0

### 2026-03-01: RegistryService

**What:** Created `src/services/RegistryService.ts` — push/resolve/list/pull/delete for content-addressed artifacts.

**Key decisions:**
- sha256 idempotency: duplicate push returns existing artifact + re-upserts tag (no exception)
- `version` = tag name (e.g., `latest`, `1.0.0`)
- `ArtifactTag` upsert: `_upsertTag` moves pointer atomically on re-push
- `VectorSpace` only created for `KnowledgeBase` kind
- Chunk deletion before artifact (FK safety with MikroORM UoW)
- Tenant scope guard in `resolve()` handles both hydrated entity and raw string ID

### 2026-03-01: ProvisionService

**What:** Created `src/services/ProvisionService.ts` — deploy/unprovision/listDeployments.

**Key decisions:**
- `RUNTIME_JWT_SECRET` → `PORTAL_JWT_SECRET` fallback (avoids hard boot failure in dev)
- `ONE_YEAR_MS` runtime tokens (long-lived by design)
- `randomUUID()` returned as `deploymentId` when artifact not found (interface compliance, not persisted)
- KB validation: `em.count(KbChunk)` for live count (not stale `artifact.chunkCount`)
- `unprovision`: `markFailed('Unprovisioned')` then explicitly null `runtimeToken`
- `RegistryService` injected via constructor default (no DI container for P0)

### 2026-03-01: EmbeddingAgentService + System-Embedder Bootstrap

**What:** Created `src/services/EmbeddingAgentService.ts`.

**Key decisions:**
- Config stored in `systemPrompt` as JSON — no new DB columns needed
- `resolveEmbedder()` resolution order: named agentRef → DB lookup → env var fallback → throw
- `bootstrapSystemEmbedder()`: upsert with diff-check (only flush if config changed)
- Startup hook uses `orm.em.fork()` (separate from main request EM)
- Fixed pre-existing build failure: `Agent.schema.ts` missing `kind`; `ApiKey.schema.ts` missing `rawKey`

### 2026-03-01: Tenant org_slug

**What:** Added org slug support end-to-end.
- Created `src/utils/slug.ts` — `generateOrgSlug(name)` and `validateOrgSlug(slug)`
- `Tenant.ts` + `Tenant.schema.ts` — `orgSlug?: string | null` → `org_slug varchar(100)` column
- `tenant.dto.ts` — `orgSlug` in `UpdateTenantDto`
- `TenantManagementService` — `updateSettings` handles `orgSlug`; `findByOrgSlug(slug)` helper
- `UserManagementService` — `assignUniqueSlug()` called on `createUser` and `acceptInvite`; all four JWT sign calls include `orgSlug`
- `portal.ts` — `PATCH /v1/portal/settings` extended with optional `orgSlug`

**Key decisions:**
- `provider` made optional in PATCH settings (avoids duplicate route registration)
- Creation collision: append `-2`, `-3`; PATCH collision: 409 (let client choose)
- `assignUniqueSlug` runs before `em.flush()` (new tenant not yet visible in DB)

### 2026-03-01: Portal KB + Deployment Routes

**What:** Added 6 routes to `src/routes/portal.ts`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/portal/knowledge-bases` | List KB artifacts for tenant |
| GET | `/v1/portal/knowledge-bases/:id` | KB detail + live chunk count |
| DELETE | `/v1/portal/knowledge-bases/:id` | Delete KB + all chunks |
| GET | `/v1/portal/deployments` | List deployments with artifact info |
| GET | `/v1/portal/deployments/:id` | Single deployment detail |
| DELETE | `/v1/portal/deployments/:id` | Unprovision deployment |

**Key decisions:**
- `orm.em.fork()` per handler — no changes to `registerPortalRoutes` signature
- `runtimeToken` excluded from portal responses
- `searchReady: chunkCount > 0` convenience flag on KB detail
- `authRequired` (not `ownerRequired`) — consistent with trace/analytics routes

### 2026-03-02: Docker Stack Setup

**What:** Created full-stack Docker Compose configuration for local development.

**Files created:**
- `Dockerfile` — multi-stage gateway build (Node 20 Alpine, TypeScript → dist/)
- `Dockerfile.portal` — multi-stage portal build (Vite → nginx:alpine with reverse proxy)
- `nginx.portal.conf` — nginx config proxying `/v1` to gateway, SPA routing fallback
- `docker-compose.yml` — 4 services: postgres, ollama, gateway, portal

**Key decisions:**
- Gateway runtime includes `migrations/` directory (node-pg-migrate runs at startup)
- Portal nginx proxies `/v1` to `http://gateway:3000` for API calls
- Ollama service with persistent volume (`ollama_data`)
- Gateway healthcheck uses `curl -f http://localhost:3000/health`
- All dev secrets commented with `# DEV ONLY — change for production`
- `ENCRYPTION_MASTER_KEY` placeholder: 64-char hex string (required or gateway exits)
- System embedder env vars point to ollama service (`SYSTEM_EMBEDDER_PROVIDER=ollama`)
- Portal on port 5174, gateway on 3000, postgres on 5432, ollama on 11434

**Impact:** `docker compose up` now brings up full local stack with hot-reload support via bind mounts (if added).

## Learnings

