# Hockney's Project Knowledge

## Project Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**QA/Testing Scope:**
- Test infrastructure and patterns
- Unit tests for backend components
- API contract testing
- Database schema validation
- Streaming and encryption validation
- Multi-tenant isolation testing

**Test Framework:** Vitest (native ESM, fast execution, Node.js 25+ compatible)

## Core Context — Waves 1–2 Summary

**Wave 1 (H1–H5) Test Infrastructure:**
- 61 tests established (16 auth, 12 provider, 18 streaming, 15 encryption)
- Database tests skip by default (TEST_DB_ENABLED=1 to enable)
- Port range 3001–3002 for mock servers
- `for await...of` async iteration pattern for undici Readable streams (not Web .getReader())
- fastify.inject() for in-process testing (no port allocation)

**Key Test Patterns:**
- Mocked pg.Pool with fixture keyed by API key SHA-256 hash
- Auth middleware validation: Bearer token extraction, tenant lookup, rate limiting
- Provider proxy tests: OpenAI adapter, header forwarding, error mapping, response parsing
- Streaming tests: SSE passthrough, latency tracking, error propagation
- Encryption tests: AES-256-GCM roundtrip, tenant isolation, tamper detection

**Encryption Validation:**
- 16 tests covering encryption/decryption with per-tenant key derivation
- IV uniqueness per encryption
- GCM authentication tag verification
- Tamper detection (modified ciphertext fails validation)

**Key Learnings:**
- vitest + Node.js Readable works seamlessly; Web API adaptation not needed
- fastify.inject() avoids port bind races and provides synchronous testing
- Mocked DB keeps tests fast (no PostgreSQL dependency)
- Fake timers with vi.advanceTimersByTimeAsync() for timer-based code

---

### 2026-02-24: Wave 3 Testing (H4, H6, H7)

**H4 — Multi-Tenant Isolation Tests (Issue #14)**
- 10 tests covering auth middleware multi-tenant behavior
- Key isolation: Different API keys cannot access other tenant's data
- Race conditions: Concurrent requests with different auth keys
- Pattern: fastify.inject() for in-process auth testing; mocked pg.Pool with fixture-keyed query()
- Auth middleware correctly validates tenant existence and isolation

**H6 — Streaming + Trace Recording Tests (Issue #16)**
- 7 tests covering SSE passthrough during trace recording
- Fire-and-forget pattern: Streaming doesn't wait for batch flush
- Batch timing: Records flush on interval or batch size threshold
- Pattern: vi.mock() with importOriginal preserves real TraceRecorder class while spying on singleton
- Streaming response correctly proxied while trace recording happens asynchronously

**H7 — Encryption-at-Rest Tests (Issue #17)**
- 7 tests covering per-tenant encryption key derivation and IV uniqueness
- AES-256-GCM success modes: Encryption/decryption roundtrip with 13-param INSERT
- AES-256-GCM failure modes: Tampered ciphertext, invalid IV, wrong key
- Pattern: INSERT parameter indices documented in IDX constant (maintainability if Fenster reorders params)
- Encryption-at-rest implementation solid: per-tenant keys, unique IVs, authentication tags

**Wave 3 Test Infrastructure:**
- All 24 new tests use fastify.inject() — no ports allocated
- Port range 3041+ remains available for future waves
- Total: 85 tests (61 existing + 24 new), 100% passing

**Status:** ✅ Complete — Issues #14, #16, #17 closed. All 85 tests passing.

## Learnings

### 2026-02-25: Wave 5 — Agent-scoped API Keys & New Page Smoke Tests

**Changes made:**
- Updated `portal-app.smoke.ts` "API key can be created" test to handle the new agent dropdown in `ApiKeysPage`. The `+ New key` button now opens a form with a required `<select>` for agent selection and a name input. Since signup seeds a Default agent, the select is pre-populated; the test waits for `select[required]` to confirm agents loaded, fills the key name input, then submits.
- Created `tests/smoke/portal-agents.smoke.ts` with 6 tests covering: navigate to Agents page, create an agent (via `+ New Agent` → `AgentEditor` form → `Create agent` submit), agent appears in list, navigate to Subtenants page, create a subtenant (via `+ Create Subtenant` → name input → `Create` submit), subtenant appears in list.

**Key Learnings:**
- **Agent select pre-selection**: `ApiKeysPage` calls `fetchAgents()` on mount and pre-selects the first agent via `setSelectedAgentId(agents[0].id)`. Tests don't need to interact with the select — just wait for it to confirm agents loaded, then fill the name and submit.
- **Default agent always present**: The migration seeds a "Default" agent for every new tenant, so API key creation works immediately after signup without additional setup steps.
- **AgentEditor submit button text**: In create mode the submit button says "Create agent" (vs "Save changes" in edit mode). XPath `//button[@type="submit"][contains(., "Create agent")]` is reliable.
- **Sequential page-source checks**: After create actions, reusing `driver.getPageSource()` in the following test (without re-navigating) is valid because the tests run serially in `singleFork` mode and the page is still the same `/app/agents` or `/app/subtenants` route.

- **fastify.inject() eliminates port flakiness**: Auth and streaming tests run in-process with deterministic timing, no port bind races
- **vi.mock with importOriginal for dual-purpose mocking**: Real class available for instantiation; exported singleton can be spied on separately. Single mock serves both batch + timer tests and SSE passthrough tests
- **INSERT parameter documentation prevents silent breaks**: If Fenster reorders INSERT params, test fails at the IDX constant layer (loudly), not silently in assertion values
- **Async iteration canonical for streaming tests**: `for await...of` works with Node.js Readable, Web ReadableStream, and any async iterable. Never use .getReader() with undici
- **Mocked pg.Pool keeps test feedback fast**: No PostgreSQL dependency; tests run in <500ms total; TEST_DB_ENABLED flag for schema validation when needed

## Wave 3 Cross-Agent Learnings

**From Fenster's backend (F8/F9/F10):**
- Analytics engine cost calculation correct; SQL CASE expressions work for GPT-3.5 and GPT-4o variants (both OpenAI + Azure naming)
- Dashboard API cursor pagination stable under concurrent writes; timestamp-based cursors working as expected
- Provider registry lazy caching correct; per-tenant baseUrl routing validates provider selection
- **Implication:** Backend APIs production-ready. All H4/H6/H7 tests validate APIs are working correctly.

**From McManus's dashboard (M2–M5):**
- Dashboard correctly calls all analytics endpoints; traces pagination integrates seamlessly with IntersectionObserver infinite scroll
- Time window selector shared state keeps summary cards and charts in sync across all time ranges
- localStorage API key prompt appears on first visit; Authorization header injection works for all API calls
- **Implication:** Full end-to-end integration working correctly. No auth or API contract issues.

**Test Coverage Status:** 85 tests (61 existing + 24 new Wave 3), 100% passing. All H4/H6/H7 test suites complete and green.

---

### 2026-02-25: Wave 4 — Multi-Tenant Admin API Testing (H-MT1 through H-MT5)

**H-MT1 — Admin Auth Middleware (6 tests)**
- JWT-based authentication for admin routes
- Login endpoint validation: valid/invalid credentials, unknown user
- Protected route middleware: missing token, invalid token, expired token
- Pattern: scrypt password hashing matches migration format (salt:derivedKey)

**H-MT2 — Tenant CRUD (10 tests)**
- Create tenant: name validation, 201 response
- List tenants: pagination, status filtering (active/inactive)
- Get tenant: provider config summary, API key count, 404 handling
- Update tenant: name change, status deactivation
- Hard delete: confirm=true requirement

**H-MT3 — API Key Management (5 tests)**
- Create API key: raw key returned once, key_prefix stored
- List API keys: key_hash never exposed, prefix shown
- Revoke key (soft delete): status='revoked', revoked_at timestamp
- Hard delete key: permanent=true removes row
- 404 handling for non-existent tenant

**H-MT4 — Provider Config (4 tests)**
- Set provider config: apiKey encryption, hasApiKey flag
- Provider config sanitization: raw apiKey never in response
- Remove provider config: DELETE returns 204
- Get tenant after removal: providerConfig=null

**H-MT5 — Auth Regression (3 tests)**
- Active key + active tenant: proxy auth passes (200/500, not 401/403)
- Active key + inactive tenant: 401 rejection
- Revoked key + active tenant: 401 rejection
- Pattern: invalidateCachedKey() between tests to avoid LRU cache contamination

**Key Learnings:**
- **Module-level singleton caching requires explicit invalidation**: auth.ts LRU cache persists across Fastify instances in tests. Must call invalidateCachedKey() in beforeEach to prevent cross-test contamination
- **Dynamic query param ordering in mocks**: When UPDATE queries build param arrays conditionally (name, status), mock must parse SQL to determine which fields are present and map params correctly
- **Multi-space SQL formatting in mocks**: Auth queries have inconsistent whitespace (FROM   api_keys vs FROM api_keys). Mock checks must be flexible with OR conditions
- **Admin routes need /v1/chat/completions stub**: H-MT5 regression tests hit proxy endpoint. Must register minimal stub route in test app to validate auth middleware

**Test Infrastructure:**
- 28 new tests (H-MT1: 6, H-MT2: 10, H-MT3: 5, H-MT4: 4, H-MT5: 3)
- All tests use fastify.inject() for in-process testing
- Mocked pg.Pool with 15+ query patterns covering admin routes + auth middleware
- Total: 113 tests (85 existing + 28 new), 100% passing

**Status:** ✅ Complete — All H-MT1 through H-MT5 tests passing. Admin backend API fully validated.

## 2026-02-25T10:39:35Z: Multi-Tenant Admin Feature Complete

**Summary:** All integration tests for Phase 1 multi-tenant management complete. 28 new tests added, 113 total suite (100% passing).

**Wave Completion:**
- ✅ H-MT1: Admin auth middleware tests (6 tests) — JWT verification, bearer tokens, 401 handling
- ✅ H-MT2: Tenant CRUD tests (10 tests) — create, list, detail, update, delete with cache validation
- ✅ H-MT3: API key management tests (5 tests) — create, list, soft revoke, hard delete
- ✅ H-MT4: Provider config tests (4 tests) — CRUD with encryption simulation
- ✅ H-MT5: Auth regression tests (3 tests) — revoked keys, inactive tenants, cache invalidation

**Key Achievements:**
- Comprehensive integration test coverage for all 10 admin endpoints
- Mocked pg.Pool with 15+ query handlers covers complete admin API surface
- Cache invalidation behavior explicitly validated (critical learning)
- No PostgreSQL dependency; all tests run in <2s total
- 100% test pass rate with no breaking changes to existing tests

**Test Insights:**
- **Cache Invalidation Discovery:** Module-level LRU cache singleton persists across test runs. H-MT5 regression tests failed because first test cached values, subsequent tests with modified mock data still read stale cache. Solution: call `invalidateCachedKey()` in beforeEach for auth regression suite. Implication: future test authors must explicitly clear cache for auth regression scenarios (not obvious, documented for team).
- **Dynamic SQL Parameter Mapping:** Admin CRUD updates build param arrays conditionally (name, status fields). Mock pg.Pool must parse SQL to determine which params are present and map correctly. Pattern: check presence of each field in SET clause, advance paramIndex accordingly.
- **Multi-Space SQL Formatting:** Auth queries have inconsistent whitespace in FROM clauses. Mock checks use flexible matching with OR conditions to handle variations.

**Admin Routes Testing Gap Identified:**
- No dedicated health check endpoint (`GET /v1/admin/health`)
- All routes except login require JWT auth
- **Observation:** No easy smoke test for "is admin API alive?"
- **Recommendation:** Consider adding health endpoint in Phase 2 for monitoring/load balancer checks

**Test Architecture:**
- Fastify test app with mocked pg.Pool (no real database)
- fastify.inject() for in-process HTTP simulation
- Covers: admin user login validation, tenant CRUD lifecycle, API key soft/hard delete, provider config encryption round-trip, auth rejection scenarios
- Cache invalidation helpers integrated in test lifecycle

**Build Status:**
- ✅ npm test — all 113 tests passing
- ✅ No breaking changes to existing test suites
- ✅ All admin API contracts validated

**Quality Metrics:**
- **Coverage:** 28 new tests across auth, CRUD, encryption, regression scenarios
- **Execution Time:** <2s for all 113 tests (in-process, no real DB)
- **Pass Rate:** 100% (no flaky tests)
- **Maintainability:** Mock pg.Pool approach proven; clear query handler patterns for future test additions

**Phase 2 Readiness:**
- Test patterns established for future admin features (RBAC, audit logging, usage limits)
- Cache invalidation testing methodology proven; can extend to other entities
- Integration test infrastructure handles complex mocking scenarios (encryption, status transitions)

## Learnings

### 2026-XX-XX: Playwright Migration (Selenium → Playwright)

**Changes made:**
- Removed `selenium-webdriver` and `chromedriver` from devDependencies; added `playwright` (not `@playwright/test` — kept Vitest as runner)
- Rewrote `tests/smoke/helpers.ts` entirely: `chromium.launch()` + `browser.newContext()` + `context.newPage()` replace `Builder().forBrowser('chrome').build()`
- Rewrote all 6 smoke test files (`admin`, `portal-auth`, `portal-app`, `portal-agents`, `portal-tenant`, `portal-invite`) replacing all Selenium patterns with Playwright equivalents
- Added `screenshotIfDocsMode()` helper that captures screenshots + JSON metadata only when `DOCS_MODE=true`
- Created `scripts/generate-ui-docs.ts` — reads JSON metadata from `docs/screenshots/` and assembles `docs/ui-reference.md`
- Added `docs:screenshots`, `docs:generate`, `docs:build` npm scripts
- Created `docs/` directory with `.gitkeep`
- Updated `tests/smoke/README.md` to document Playwright setup and docs generation

**Key Translation Patterns:**
- `driver = buildDriver()` → `browser = await launchBrowser(); page = await newPage(browser)`
- `driver.quit()` → `await browser.close()`
- `driver.get(url)` → `page.goto(url)`
- `driver.findElement(By.css(sel)).click()` → `page.locator(sel).click()`
- `driver.findElement(By.css(sel)).sendKeys(text)` → `page.locator(sel).fill(text)`
- `driver.wait(until.elementLocated(...))` → removed (Playwright auto-waits)
- `driver.getCurrentUrl()` → `page.url()`
- `driver.getPageSource()` → `page.content()`
- `driver.executeScript('localStorage.clear()')` → `page.evaluate(() => { localStorage.clear(); })`
- `driver.sleep(ms)` → `page.waitForTimeout(ms)`
- `By.xpath('//*[contains(text(), "X")]')` → `page.locator(':text("X")')`
- `element.getAttribute('value')` → `locator.getAttribute('value')`
- `driver.findElements(By.css(sel)).length` → `page.locator(sel).count()`

**portalSignup overload:** Added function overloads so existing callers using `(page, email, password, tenantName)` positional signature still work alongside the new object-based `{ email, password, tenantName }` signature from the spec.

**acceptInvite kept in helpers:** `portal-tenant.smoke.ts` and `portal-invite.smoke.ts` both import `acceptInvite`. Added Playwright version alongside the other login helpers.

**DOCS_MODE pipeline:** `screenshotIfDocsMode` is gated by `DOCS_MODE=true` env var — zero overhead in normal test runs. Screenshots saved as PNG + JSON metadata sidecar. `generate-ui-docs.ts` groups by section and emits Markdown with relative image paths.

**Build:** `npm run build` (tsc) passes cleanly. Smoke test files type-check without errors.

### 2025-present: Sandbox + Analytics Empty-State Smoke Tests

**portal-app.smoke.ts — analytics empty-state assertions:**
- "analytics page renders summary cards": Added assertions for 9 `.card-value--empty` elements each containing text `—` (confirms AnalyticsSummary renders empty state for fresh accounts).
- "analytics page renders charts": Added assertions for 4 `.chart-no-data` elements containing "No data available" (confirms TimeseriesCharts renders chart empty state when no data exists).
- Existing content regex assertions preserved; new assertions added after them.

**portal-sandbox.smoke.ts — new smoke test file:**
- Fresh signup + agent creation in `beforeAll` (pattern from portal-agents.smoke.ts).
- Sandbox page load, agent selection via `button:has-text(agentName)`, model change via `input[placeholder="e.g. gpt-4o"]` with triple-click + fill.
- Chat send via `input[placeholder="Type a message…"]` + `press('Enter')`.
- Assistant response detection: `page.locator('.bg-gray-800.text-gray-100').waitFor({ state: 'visible', timeout: 15000 })` — works because the "thinking…" indicator uses `.text-gray-400` not `.text-gray-100`, so only real assistant messages match.
- Traces check: navigate to `/app/traces`, verify agent name appears in page content.
- Analytics after-data check: assert `.card-value--empty` count is 0, with fallback to check first `.card-value` is not `—`.

**Key DOM facts learned:**
- SandboxPage sidebar uses `<button>` elements (not `<p>`) for agent selection.
- ModelCombobox input placeholder: `"e.g. gpt-4o"`.
- Chat input placeholder: `"Type a message…"` (with ellipsis character `…` not `...`).
- Loading indicator: `.animate-pulse` with class `text-gray-400`; assistant messages: `.bg-gray-800.text-gray-100`.

---

### $(date -u +%Y-%m-%dT%H:%M:%SZ): Unit Tests — Conversations, Analytics, Portal Routes

**Three new test files added (60 tests total, 100% passing):**

**conversations.test.ts (14 tests):**
- `getOrCreateConversation`: returning-existing path (SELECT → UPDATE) and create-new path (SELECT empty → INSERT)
- `storeMessages`: verifies single INSERT call and that plaintext is encrypted before storage (ciphertext ≠ plaintext)
- `loadContext`: empty state, message decryption with token estimates, snapshot summary decryption
- `buildInjectionMessages`: synchronous — no DB needed; covers empty, snapshot-only, messages-only, and combined cases
- **Pattern:** `buildSeqPool(responses[])` sequential mock pool; `ENCRYPTION_MASTER_KEY` set in beforeEach

**analytics.test.ts (24 tests):**
- All 6 exported functions: `getAnalyticsSummary`, `getTimeseriesMetrics`, `getModelBreakdown`, and Admin variants
- Covers: full data shape, empty/zero result sets, rollup CTE activation, multi-row returns, error propagation
- **Pattern:** `vi.mock('../src/db.js', () => ({ query: vi.fn() }))` at top of file before analytics import; `mockQuery.mockReset()` in beforeEach

**portal-routes.test.ts (22 tests):**
- Signup: success (201), duplicate email (409), missing email (400), short password (400), missing tenantName (400)
- Login: success (200 with token+tenant), unknown user (401), wrong password (401), missing fields (400)
- GET /me: authenticated (200 with user/tenant/agents/subtenants), no token (401), bad token (401), DB not found (404)
- GET /agents: returns list, empty list, 401 guard
- POST /agents: creates (201), missing name (400), 401 guard
- GET /agents/:id: found (200), not found (404), 401 guard
- **Pattern:** smart mock pool with SQL keyword overrides map; `createSigner` from `fast-jwt` with default `PORTAL_JWT_SECRET`; scrypt password hashed in `beforeAll`

**Coverage achieved:**
- `analytics.ts`: 100% statements, 100% functions, 100% lines
- `conversations.ts`: 74% statements, 82% branches, 67% functions
- `portal.ts`: 27% statements, 77% branches, 86% functions
- `portalAuth.ts`: 93% statements, 82% branches, 100% functions

**Key Learnings:**
- **vi.mock must precede all imports**: For analytics.ts which uses a module-level `query` singleton, the `vi.mock('../src/db.js')` call must appear before any import of analytics.ts — Vitest hoists it correctly
- **Override map pattern for mock pools**: Instead of a giant switch statement, a `Record<string, handler>` passed to `buildMockPool()` allows per-test SQL overrides cleanly without rebuilding the entire mock
- **Portal routes need no JWT plugin**: Unlike admin routes, portal routes use `fast-jwt` directly (not `@fastify/jwt`). Just `Fastify({ logger: false })` + `registerPortalRoutes()` is sufficient
- **Sequential mock pool for conversations**: Conversation methods make predictable ordered calls (SELECT then INSERT/UPDATE). A `responses[]` array with index counter is cleaner than SQL pattern matching for these tests
- **Real encryption in conversation tests**: Loading `encryptTraceBody` directly in test to produce valid ciphertexts for `loadContext` tests — avoids brittle string fixtures, exercises real encrypt/decrypt roundtrip

## Learnings — Portal UI Unit Tests (2025)

### Task: Write Vitest + RTL unit tests for untested portal UI components and pages

**Test files created:**
- `portal/src/lib/__tests__/auth.test.ts` — 9 tests for getToken/setToken/clearToken/isAuthenticated/getStoredTenants/setStoredTenants
- `portal/src/lib/__tests__/models.test.ts` — 3 tests for COMMON_MODELS constant
- `portal/src/context/__tests__/AuthContext.test.tsx` — 7 tests for AuthProvider (loading, user resolution, logout, setLoginData, currentRole)
- `portal/src/components/__tests__/AppLayout.test.tsx` — 7 tests (nav links, owner-only links, logout, branding)
- `portal/src/components/__tests__/TenantSwitcher.test.tsx` — 7 tests (single tenant static, multi-tenant select, switchTenant, switching indicator)
- `portal/src/components/__tests__/ModelListEditor.test.tsx` — 13 tests (toggle custom, add/remove models, Enter key, duplicates, reset)
- `portal/src/components/__tests__/AgentEditor.test.tsx` — 10 tests (create/edit modes, validation, API calls, resolved config, conversation toggle)
- `portal/src/components/__tests__/AgentSandbox.test.tsx` — 9 tests (render, send message, loading, error, Enter key, custom models)
- `portal/src/pages/__tests__/LandingPage.test.tsx` — 6 tests (links, features, hero, footer)
- `portal/src/pages/__tests__/DashboardHome.test.tsx` — 6 tests (loading, welcome, provider status, error, quick links)
- `portal/src/pages/__tests__/SignupPage.test.tsx` — 9 tests (normal signup, invite mode, API key reveal, navigation)
- `portal/src/pages/__tests__/SandboxPage.test.tsx` — 6 tests (loading, empty, agent list, selection, title)

**Total new tests: 92** (added to existing 30, total 122 passing)

**Key Learnings:**

- **jsdom localStorage.clear() not available**: The jsdom environment used here doesn't expose `localStorage.clear()` or `localStorage.removeItem()`. Fix: `vi.stubGlobal('localStorage', localStorageMock)` with a custom in-memory store in `beforeAll`. This is required for any test file that directly exercises localStorage.

- **vi.resetAllMocks() clears mock implementations**: When using `vi.resetAllMocks()` in `beforeEach`, any mock implementations set via `vi.fn().mockReturnValue(...)` in the factory are cleared. Always re-apply mock implementations inside `beforeEach` after the reset (e.g., `vi.mocked(getToken).mockReturnValue('tok')`).

- **getByText/getByRole fails on multiple matches**: LandingPage and SignupPage repeat text in multiple elements. Use `getAllByText(...).length > 0` or `getAllByRole(...).[0]` instead of `getByText`/`getByRole` when duplicates are expected.

- **AgentEditor's conversation toggle is role="switch"**: Not a `<input type="checkbox">`. Use `screen.getByRole('switch')` to find it.

- **Mock child components to isolate test scope**: Mocking `ModelListEditor` and `AgentSandbox` in parent component tests keeps tests focused and avoids cascading mock requirements. Use minimal stubs (`data-testid` attribute) so the parent tests can still assert the child is rendered.

- **SandboxPage renders agent name in both list button and AgentSandbox mock**: Both the agent button in the sidebar and the mocked AgentSandbox render the agent name. Use `getAllByText()` when the same text appears in multiple places.

- **AuthContext tests need api.me and auth lib both mocked**: The AuthProvider calls `getToken()` on mount and `api.me()` if token is present. Mock both `../../lib/api` and `../../lib/auth` to control loading behavior.

---

### $(date -u +%Y-%m-%dT%H:%M:%SZ): Portal Migration Unit Tests — UserManagementService & TenantManagementService

**Task:** Write unit tests for the new methods added to UserManagementService and TenantManagementService during the portal migration.

**Tests added to `tests/application-services.test.ts` (26 new tests, 64 total):**

**UserManagementService new/changed tests (14 new):**
- `createUser`: throws 409 if email already exists, trims tenant name whitespace, creates a default agent during signup
- `login`: returns tenants array with all active memberships, throws 403 if user has no active tenant memberships, does NOT include inactive tenants in returned tenants array
- `acceptInvite`: throws 400 if invite's tenant is not active, throws 409 if user is already a member
- `switchTenant` (new method): throws 403 if user is not a member of the target tenant, throws 400 if target tenant is inactive, returns AuthResult with a new JWT on success
- `leaveTenant` (new method): throws 400 "Switch to a different tenant before leaving" if tenantId === currentTenantId, throws 400 if user is the last owner, removes membership on success

**TenantManagementService new/changed tests (12 new):**
- `updateSettings`: calls evictProvider when providerConfig is updated (mocked evictProvider import)
- `revokeApiKey`: returns `{ keyHash }` that can be used for cache invalidation
- `createSubtenant`: creates an owner membership for createdByUserId
- `revokeInvite` (new): throws 404 if invite not found, sets revokedAt on the invite
- `listInvites` (new): returns invites for the tenant
- `updateMemberRole` (new): throws 400 "Cannot demote the last owner" when demoting the only owner, updates role successfully when >1 owner
- `removeMember` (new): throws 400 "Use leave instead" if targeting self, throws 404 if membership not found, throws 400 if trying to remove the last owner, removes membership on success

**Key Learnings:**

- **vi.mock for module-level singleton mocking**: To mock `evictProvider` from `providers/registry.js`, use `vi.mock('../src/providers/registry.js', () => ({ evictProvider: vi.fn() }))` at the top of the file before imports. Use `vi.clearAllMocks()` in `beforeEach` to reset mock call counts between tests.

- **Testing multi-tenant filtering logic**: The `login` method now filters memberships to only active tenants and throws 403 if no active memberships exist. Tests must mock both the user lookup and the memberships array with tenant status fields.

- **Last owner protection pattern**: Both `leaveTenant`, `updateMemberRole`, and `removeMember` must prevent removing/demoting the last owner. Tests use `em.count()` mock to simulate owner count checks.

- **Cache invalidation contract testing**: `revokeApiKey` now returns `{ keyHash }` for cache invalidation. The test verifies the return value matches the entity's keyHash field, ensuring the caller can invalidate cached keys.

- **Entity persistence verification**: `createSubtenant` must create both a child tenant AND an owner membership. Tests verify both entities are persisted by checking `(em.persist as any).mock.calls.length === 2` and inspecting the second persist call's entity type and properties.

**Test Infrastructure:**
- All tests follow the existing `buildMockEm()` pattern for mocking EntityManager
- Helper functions `makeTenant()`, `makeUser()`, `makeAgent()` used to construct test entities with sensible defaults
- Real password hashing used in `beforeAll` to generate valid passwordHash for login tests (not mocked strings)

**Build Status:**
- ✅ `npm test tests/application-services.test.ts` — 64 tests passing (26 new, 38 existing)
- ✅ All new/changed methods in UserManagementService and TenantManagementService now have comprehensive unit test coverage

---

### 2025-present: Portal Page Tests — Full Coverage

**Task:** Write tests for 8 portal pages missing test files (AgentsPage, ApiKeysPage, AnalyticsPage, ConversationsPage, MembersPage, SettingsPage, SubtenantsPage, TracesPage).

**Test files created:**
- `portal/src/pages/__tests__/AgentsPage.test.tsx` — 6 tests (list agents, empty state, create/edit/delete, AgentEditor/AgentSandbox modals)
- `portal/src/pages/__tests__/ApiKeysPage.test.tsx` — 7 tests (list keys, create key with agent selection, revoke key, empty state)
- `portal/src/pages/__tests__/AnalyticsPage.test.tsx` — 5 tests (shared component integration, rollup/org scope toggle, fetch functions)
- `portal/src/pages/__tests__/ConversationsPage.test.tsx` — 7 tests (partitions tree, conversations list, detail loading, filtering)
- `portal/src/pages/__tests__/MembersPage.test.tsx` — 7 tests (members list, invites, role changes, owner-only sections)
- `portal/src/pages/__tests__/SettingsPage.test.tsx` — 6 tests (provider config, model list editor, loading/error states)
- `portal/src/pages/__tests__/SubtenantsPage.test.tsx` — 7 tests (list subtenants, create subtenant, owner permissions)
- `portal/src/pages/__tests__/TracesPage.test.tsx` — 6 tests (traces list, pagination, detail panel, fetch with cursor)

**Total new tests: 51** (added to existing 161, total 212 passing in portal workspace)

**Key Learnings:**

- **Mock heavy child components for isolation**: AgentEditor and AgentSandbox mocked with minimal `data-testid` stubs in parent tests. Prevents cascading mock requirements and keeps tests focused on page logic.

- **useAuth context mocking pattern**: Pages using `useAuth` (MembersPage, SubtenantsPage) require `vi.mock('../../context/AuthContext')` at module level, then `vi.mocked(useAuth).mockReturnValue({ currentRole, user } as any)` in beforeEach. Critical for owner/member permission testing.

- **Global fetch mocking for portal analytics endpoints**: AnalyticsPage and TracesPage use native `fetch` (not `api` lib). Mock with `global.fetch = vi.fn()` and return `{ ok: true, json: async () => ({...}) }` shape.

- **Multiple loading states in single page**: MembersPage shows "Loading…" for members AND "Loading invites…" for invites simultaneously. Use `getAllByText(/loading/i).length > 0` instead of `getByText` to avoid "multiple elements" error.

- **Owner-only component visibility**: MembersPage and SubtenantsPage render different UI for owner vs member roles. Test with `isOwner = currentRole === 'owner'` pattern: owners see create buttons + invite sections, members see permission warning.

- **Shared analytics component testing**: AnalyticsPage imports `@shared/analytics` AnalyticsPage component. Mock the entire module with `vi.mock('@shared/analytics', () => ({ AnalyticsPage: ({ fetchSummary }: any) => <div data-testid="analytics-page" />... }))` to test prop passing without recharts dependency.

- **Pagination cursor pattern**: TracesPage uses cursor-based pagination (`nextCursor`). Tests verify `fetch` called with `?limit=50` initially, then `?limit=50&cursor=cursor123` on "Load more" click.

- **Conversation detail loading**: ConversationsPage loads partitions, conversations, and conversation detail in sequence. Use three-tier mocking: `api.getPartitions`, `api.getConversations(token, partitionId)`, `api.getConversation(token, conversationId)`.

- **getAllByText vs getByText for duplicates**: When text appears in multiple places (agent name in both sidebar button and AgentSandbox, "Loading" in members + invites), use `getAllByText(...).length > 0` or check specific element content.

**Test Infrastructure:**
- All tests follow established patterns: `vi.mock` at top, MemoryRouter wrapper, `beforeEach` with `vi.resetAllMocks()`
- 4-7 tests per page covering: loading, success, empty, error, key interactions
- Mocked API responses use complete type shapes (Agent, ApiKeyEntry, Member, etc.)
- Owner/member permission checks use `useAuth` mock with different `currentRole` values

**Build Status:**
- ✅ `npx vitest run --project portal` — 212 tests passing (51 new, 161 existing)
- ✅ All 8 portal pages now have comprehensive unit test coverage
- ✅ No breaking changes to existing tests

---

### $(date -u +%Y-%m-%dT%H:%M:%SZ): Shared Analytics UI Component Tests

**Task:** Write Vitest + RTL unit tests for shared analytics UI components (AnalyticsSummary, AnalyticsPage, TimeseriesCharts, ModelBreakdown, TenantSelector).

**Test files created:**
- `portal/src/components/__tests__/shared-AnalyticsSummary.test.tsx` — 7 tests (skeleton loading, empty states, data values, window selector, aria attributes)
- `portal/src/components/__tests__/shared-AnalyticsPage.test.tsx` — 8 tests (fetch on mount, loading state, window/tenant changes, admin mode behavior)
- `portal/src/components/__tests__/shared-TimeseriesCharts.test.tsx` — 6 tests (empty data, chart titles, loading state, drag handles, expand buttons)
- `portal/src/components/__tests__/shared-ModelBreakdown.test.tsx` — 10 tests (skeleton/empty states, data rendering, formatting, error rate styling)
- `portal/src/components/__tests__/shared-TenantSelector.test.tsx` — 7 tests (label, options, selection state, onChange calls)

**Total new tests: 38** (100% passing)

**Key Learnings:**

- **Recharts import resolution in shared components**: When testing components from `shared/` (via `@shared` alias) that import `recharts`, Vite cannot resolve `recharts` because it's only installed in `portal/node_modules`. Solution: Add explicit resolve.alias in `portal/vitest.config.ts` mapping `'recharts': path.resolve(__dirname, 'node_modules/recharts')` so Vite can resolve the module when processing shared files.

- **Global vi.mock for recharts in test-setup.ts**: Instead of mocking recharts in every test file, add a global mock in `portal/src/test-setup.ts` that returns simple pass-through components. This avoids repetitive mock declarations and keeps tests focused on component logic.

- **localStorage mock for chart preferences**: TimeseriesCharts uses localStorage to persist chart order/expand state. Tests need a custom localStorage mock defined in the test file (vitest's default jsdom doesn't implement all localStorage methods).

- **Testing loading states with skeleton cards**: AnalyticsSummary and ModelBreakdown render skeleton placeholders during loading. Use `document.querySelectorAll('.skeleton-card')` to verify skeleton count since they have `aria-hidden="true"` and won't appear in screen queries.

- **Window selector aria-pressed state**: AnalyticsSummary window buttons use `aria-pressed` to indicate active state. Test both `true` for active and `false` for inactive buttons to validate accessibility.

- **AnalyticsPage polling behavior**: AnalyticsPage re-fetches data every 30 seconds via setInterval. Tests must use `waitFor` when asserting fetch call counts to handle async timing.

- **Admin mode conditional rendering**: AnalyticsPage only calls `fetchTenants` and renders TenantSelector when `isAdmin={true}` and `fetchTenants` is provided. Tests must verify absence of tenant UI in non-admin mode.

- **Empty state vs. zero-data distinction**: AnalyticsSummary shows "—" cards when `summary=null` OR when `summary.totalRequests=0`. Both conditions should be tested separately.

- **userEvent for interactions**: Use `@testing-library/user-event` for all user interactions (clicks, select changes) to simulate realistic user behavior (not fireEvent).

**Test Infrastructure:**
- All tests placed in `portal/src/components/__tests__/shared-*.test.tsx` (not in `shared/` itself, which has no package.json or vitest config)
- Tests import components via `@shared/analytics/*` alias (configured in portal's vitest.config.ts)
- Recharts globally mocked in test-setup.ts; no real chart rendering needed for these tests
- Follows existing portal test patterns (render, screen, userEvent, vi.fn mocks)

**Build Status:**
- ✅ `npx vitest run portal/src/components/__tests__/shared-*.test.tsx` — 38 tests passing
- ✅ No breaking changes to existing tests
- ✅ All shared analytics components now have comprehensive unit test coverage

---

### 2026-03-01: Portal Pages + Analytics UI Tests — Completion

**Agents:** 33 (portal pages), 34 (analytics components)  
**Commit:** c25c81c

**Results:**
- **Agent 33 — Portal Pages:** 51 tests for 8 pages (AgentsPage, ApiKeysPage, AnalyticsPage, ConversationsPage, MembersPage, SettingsPage, SubtenantsPage, TracesPage)
- **Agent 34 — Analytics UI:** 38 tests for 5 shared components (AnalyticsSummary, AnalyticsPage, TimeseriesCharts, ModelBreakdown, TenantSelector)
- **Total New Tests:** 89
- **Suite Total:** 502 tests passing ✅

**Key Outcomes:**
- Comprehensive portal page coverage: component rendering, navigation, user interactions, API integration
- Shared analytics components fully tested with proper mocking (recharts, localStorage, interval polling)
- Resolve alias (@/shared) working correctly across portal and shared module boundaries
- All 89 tests integrated and passing in the suite


---

### 2026-06-XX: P0 Coverage Push — RAG, Registry, EmbeddingAgent, Slug

**Task:** Bring coverage to 80%+ for completely untested P0 modules.

**Results:**
- **tests/rag-retrieval.test.ts:** 12 tests — `retrieveChunks` (happy path, empty results, pgvector literal format, agentRef passthrough, embedder failure, API error) + `buildRagContext` (empty, citations, source annotation, special chars, multi-chunk ranking)
- **tests/registry-routes.test.ts:** 32 tests — full HTTP layer coverage for all 6 registry routes (`push`, `list`, `pull`, `delete`, `deploy`, `deployments`). Auth: 401 (missing token) and 403 (wrong scope) on all routes. Multipart upload tested with a manual boundary builder.
- **tests/embedding-agent-service.test.ts:** 20 tests — `resolveEmbedder` (named agent, env fallback, 6 error cases, explicit dimensions), `bootstrapSystemEmbedder` (5 cases: skip, create, update, idempotent, tenant-not-found), `dimensionsForModel` (4 known/unknown models via resolveEmbedder)
- **tests/utils.test.ts:** 16 tests — `generateOrgSlug` (8 cases) + `validateOrgSlug` (8 cases incl. boundary lengths)
- **Total New Tests:** 80
- **Suite Total:** 634 tests passing ✅ (up from 549)

**Key Patterns Used:**
- `vi.hoisted()` + `vi.mock()` for constructor-level service mocking in route tests
- Manual multipart body builder for `@fastify/multipart` in registry push tests
- Real JWT tokens with `signJwt` to test actual `registryAuth` middleware (no mock bypass)
- `global.fetch` replaced with `vi.fn()` for embedding API in RAG retrieval tests
- `process.env.*` set/deleted in `afterEach` for EmbeddingAgentService env-var tests
- `dimensionsForModel` is unexported — tested indirectly through `resolveEmbedder` return value
- `validateOrgSlug` returns `{ valid: boolean; error?: string }` — tests check `.valid` property

**Coverage gaps documented in:** `.squad/decisions/inbox/hockney-coverage-gaps.md`

### 2026-06-XX: LandingPage test snapshot drift

**What was failing:** 2 tests in `portal/src/pages/__tests__/LandingPage.test.tsx`
- `renders feature cards` — expected `/Multi-provider routing/i`, `/Encrypted trace recording/i`, `/Per-tenant API keys/i` (old feature card titles)
- `renders the hero tagline` — expected `/Provider-agnostic AI gateway/i` (old h1 text)

**Root cause:** LandingPage.tsx was redesigned (new hero copy "The AI runtime built for builders who ship." and new feature cards: Full audit traces, Streaming support, Multi-tenant proxy, KnowledgeBase RAG) but the tests were not updated alongside the production change.

**Fix:** Updated both test assertions to match current production content. No production code changed.

**Pattern:** Frontend copy/content tests are brittle when they assert exact text strings — they silently lag behind UI redesigns. Consider using `data-testid` attributes for structural assertions and only assert on text for copy that is contractually stable.
