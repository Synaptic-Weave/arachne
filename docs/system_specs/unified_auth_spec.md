# Arachne Unified Authentication Specification

> Tracked by [#192](https://github.com/Synaptic-Weave/arachne/issues/192)

## Status

Draft (MVP Specification)

**Last Updated:** 2026-03-24

------------------------------------------------------------------------

## Overview

Arachne currently maintains three separate authentication domains: Portal (tenant self-service), Admin (platform operations), and Gateway (API key resolution). Each domain uses its own JWT secret, middleware stack, and user entity. This fragmentation creates maintenance burden, inconsistent authorization semantics, and duplicated code paths. The admin dashboard is a separate React SPA served at `/dashboard`, further splitting the user experience.

This specification addresses four interrelated concerns. First, the auth domain merge collapses Admin and Portal into a single identity system backed by the existing `users` table with an added `platform_role` column, eliminating the separate `admin_users` table and second JWT secret. Second, OIDC SSO enables enterprise tenants to authenticate via external identity providers (Google, Azure AD, Okta, or any certified OIDC provider). Third, RBAC formalization replaces ad-hoc string-based role checks with a structured permission model and reusable middleware. Fourth, the dashboard merge folds the operator dashboard views into the portal SPA, removing a separate build target and unifying the frontend experience.

Together these changes reduce the authentication surface area from five middleware files and three JWT secrets to a single auth layer with one secret, while adding enterprise-grade SSO and fine-grained access control.

------------------------------------------------------------------------

## Design Goals

1. **Single identity:** One `users` table, one JWT secret (`AUTH_JWT_SECRET`), one session middleware. No separate admin user management.
2. **Backward compatible migration:** Existing portal JWTs remain valid during a transition window. Existing API key auth is unchanged.
3. **Enterprise SSO ready:** Tenant owners can configure OIDC connections. Users authenticating via SSO skip password entry and are provisioned automatically.
4. **Permission-based authorization:** Route handlers declare required permissions (not roles). Roles map to permission sets. Custom roles are a stretch goal.
5. **Unified frontend:** Dashboard views (traces, analytics) become portal routes accessible to owners and superadmins. No separate SPA build.
6. **Gateway overhead unchanged:** API key auth path (LRU cache, SHA-256 lookup) is not affected. The <20ms overhead target is preserved.

------------------------------------------------------------------------

## 1. Auth Domain Merge

### 1.1 Current State

The platform maintains two independent user tables and two JWT domains:

| Aspect | Portal | Admin |
|--------|--------|-------|
| Table | `users` | `admin_users` |
| Entity | `User` (email, passwordHash) | `AdminUser` (username, passwordHash, mustChangePassword) |
| Secret | `PORTAL_JWT_SECRET` | `ADMIN_JWT_SECRET` |
| Middleware | `portalAuth.ts` (createBearerAuth factory) | `adminAuth.ts` (createBearerAuth factory) |
| JWT payload | `{ sub, tenantId, role, scopes?, orgSlug? }` | `{ sub, username }` |
| Expiry | 24h | 8h |
| Routes | `/v1/portal/*` | `/v1/admin/*` |

Additionally, registry auth falls back to `PORTAL_JWT_SECRET` via `REGISTRY_JWT_SECRET`, and runtime auth falls back similarly via `RUNTIME_JWT_SECRET`.

### 1.2 Target State

A single `users` table with a `platform_role` column replaces both tables:

```sql
ALTER TABLE users
  ADD COLUMN platform_role VARCHAR(20) NOT NULL DEFAULT 'user',
  ADD COLUMN display_name VARCHAR(255),
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sso_provider VARCHAR(100),       -- NULL for password-based users
  ADD COLUMN sso_subject  VARCHAR(255);       -- external IdP subject identifier

CREATE UNIQUE INDEX idx_users_sso ON users (sso_provider, sso_subject)
  WHERE sso_provider IS NOT NULL;
```

**Platform roles** (column `platform_role`):

| Value | Description |
|-------|-------------|
| `user` | Standard tenant user (default). Access governed entirely by tenant memberships. |
| `superadmin` | Platform operator. Can access all tenants, system analytics, and platform configuration. |

A superadmin is still a regular user: they have an email, can belong to tenants via memberships, and log in through the same portal endpoint. The only difference is that superadmin status grants access to platform-wide admin routes.

**Admin user migration:** Each existing `admin_users` row is migrated into `users` with `platform_role = 'superadmin'`. The username is mapped to an email address (e.g., `admin` becomes `admin@platform.local` or a configurable domain). The `admin_users` table is retained as read-only for one release cycle, then dropped.

### 1.3 Unified JWT

One secret (`AUTH_JWT_SECRET`) signs all session JWTs. The env vars `PORTAL_JWT_SECRET` and `ADMIN_JWT_SECRET` are accepted as fallbacks during the transition window (if `AUTH_JWT_SECRET` is unset, fall back to `PORTAL_JWT_SECRET`).

Registry and runtime JWTs also use `AUTH_JWT_SECRET` (with their respective env var overrides retained for backward compatibility).

**Unified JWT payload:**

```typescript
interface SessionJwtPayload {
  sub: string;            // user.id (UUID)
  tenantId: string;       // currently active tenant
  role: string;           // tenant-scoped role: 'owner' | 'member'
  platformRole: string;   // 'user' | 'superadmin'
  scopes: string[];       // permission scopes (registry, RBAC)
  orgSlug: string | null; // tenant org slug
  iat: number;
  exp: number;
}
```

**Expiry:** 24 hours for all session JWTs (unified). Superadmin sessions do not get a shorter window because they are protected by permission checks, not token lifetime.

### 1.4 Unified Middleware

Replace `portalAuth.ts`, `adminAuth.ts`, and `registryAuth.ts` with a single `sessionAuth.ts`:

```typescript
// src/middleware/sessionAuth.ts
import { createBearerAuth } from './createBearerAuth.js';

const AUTH_JWT_SECRET =
  process.env.AUTH_JWT_SECRET ??
  process.env.PORTAL_JWT_SECRET ??
  'unsafe-auth-secret-change-in-production';

export interface SessionUser {
  userId: string;
  tenantId: string;
  role: string;           // tenant-scoped
  platformRole: string;   // 'user' | 'superadmin'
  scopes: string[];
  orgSlug: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser;
  }
}

export const sessionAuth = createBearerAuth<SessionJwtPayload>(
  AUTH_JWT_SECRET,
  (payload, request) => {
    request.sessionUser = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      platformRole: payload.platformRole ?? 'user',
      scopes: payload.scopes ?? [],
      orgSlug: payload.orgSlug ?? null,
    };
  }
);

export function requireSuperadmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.sessionUser?.platformRole !== 'superadmin') {
    return reply.code(403).send({ error: 'Superadmin access required' });
  }
}
```

### 1.5 Route Migration

| Current Route Prefix | Current Auth | Target Auth |
|----------------------|-------------|-------------|
| `/v1/portal/*` | `portalAuth` middleware | `sessionAuth` middleware |
| `/v1/admin/*` | `adminAuth` middleware | `sessionAuth` + `requireSuperadmin` |
| `/v1/registry/*` | `registryAuth` middleware | `sessionAuth` + `requirePermission` (scope-based) |
| `/v1/traces`, `/v1/analytics/*` | gateway API key auth | `sessionAuth` (tenant-scoped data) |

Admin routes (`/v1/admin/*`) remain at their current URL prefix for backward compatibility. They switch from `adminAuthMiddleware` to `[sessionAuth, requireSuperadmin]` as preHandlers.

### 1.6 Affected Files

- `src/middleware/portalAuth.ts` (replaced by `sessionAuth.ts`)
- `src/middleware/adminAuth.ts` (removed)
- `src/middleware/registryAuth.ts` (updated to use `AUTH_JWT_SECRET`)
- `src/auth/secrets.ts` (updated: single `AUTH_JWT_SECRET` export)
- `src/auth/jwtUtils.ts` (unchanged: generic sign/verify)
- `src/routes/portal.ts` (swap middleware references)
- `src/routes/admin.ts` (swap middleware, remove separate login endpoint)
- `src/routes/dashboard.ts` (swap to sessionAuth)
- `src/application/services/UserManagementService.ts` (issue unified JWTs)
- `src/application/services/AdminService.ts` (merge admin user ops into UserManagementService)
- `src/domain/entities/User.ts` (add `platformRole`, `mustChangePassword`, SSO fields)
- `src/domain/entities/AdminUser.ts` (deprecated, then removed)
- `src/domain/schemas/User.schema.ts` (add new columns)
- `src/domain/schemas/AdminUser.schema.ts` (deprecated, then removed)

------------------------------------------------------------------------

## 2. OIDC SSO

### 2.1 Schema

```sql
CREATE TABLE sso_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type VARCHAR(50) NOT NULL,    -- 'google', 'azure_ad', 'okta', 'custom_oidc'
  display_name  VARCHAR(255) NOT NULL,   -- "Sign in with Google"
  issuer_url    VARCHAR(500) NOT NULL,   -- OIDC issuer (discovery via .well-known)
  client_id     VARCHAR(255) NOT NULL,
  client_secret TEXT NOT NULL,           -- encrypted (AES-256-GCM, per-tenant key)
  scopes        TEXT NOT NULL DEFAULT 'openid email profile',
  enforce_sso   BOOLEAN NOT NULL DEFAULT false,  -- block password login when true
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_type)
);
```

### 2.2 Authentication Flow

```
User                     Portal SPA              Arachne API             IdP
 |                          |                        |                    |
 |  Click "Sign in with X"  |                        |                    |
 |------------------------->|                        |                    |
 |                          | GET /v1/portal/auth/   |                    |
 |                          |   sso/authorize?       |                    |
 |                          |   tenant=slug&         |                    |
 |                          |   provider=google      |                    |
 |                          |----------------------->|                    |
 |                          |                        | Build auth URL     |
 |                          |                        | (PKCE code_verifier|
 |                          |                        |  stored in session)|
 |                          |  302 redirect to IdP   |                    |
 |                          |<-----------------------|                    |
 |  Redirect to IdP login   |                        |                    |
 |<-------------------------|                        |                    |
 |                          |                        |                    |
 |  Authenticate at IdP     |                        |                    |
 |--------------------------------------------------------->             |
 |                          |                        |                    |
 |  Redirect back with code |                        |                    |
 |<---------------------------------------------------------|            |
 |                          |                        |                    |
 |  GET /v1/portal/auth/    |                        |                    |
 |    sso/callback?code=... |                        |                    |
 |------------------------->|----------------------->|                    |
 |                          |                        | Exchange code for  |
 |                          |                        | ID token (PKCE)    |
 |                          |                        |------------------->|
 |                          |                        |<-------------------|
 |                          |                        |                    |
 |                          |                        | Validate ID token  |
 |                          |                        | Find or create user|
 |                          |                        | Issue session JWT  |
 |                          |                        |                    |
 |                          |  { token, user, tenant }                    |
 |                          |<-----------------------|                    |
 |  Logged in               |                        |                    |
 |<-------------------------|                        |                    |
```

### 2.3 User Provisioning (Find-or-Create)

On SSO callback:

1. Extract `email`, `sub` (subject), and `name` from the ID token claims.
2. Look up user by `(sso_provider, sso_subject)` index. If found, update `lastLogin` and issue JWT.
3. If not found by SSO subject, look up by `email`. If found, link the SSO identity (set `sso_provider` and `sso_subject` on the existing user). This supports existing password users transitioning to SSO.
4. If no user exists, auto-create: insert into `users` with `sso_provider`, `sso_subject`, a random placeholder `passwordHash` (unusable for login), and create a `TenantMembership` with role `member` for the SSO connection's tenant.

### 2.4 SSO Enforcement

When `sso_connections.enforce_sso = true` for a tenant:

- The password login endpoint (`POST /v1/portal/auth/login`) checks whether the user's active tenant has SSO enforcement enabled. If so, it returns `403 { error: 'This organization requires SSO login.' }`.
- Superadmin users bypass SSO enforcement (they always need a password-based escape hatch).
- The signup endpoint is similarly blocked for enforced tenants (new members must come through SSO).

### 2.5 Portal Configuration

Tenant owners configure SSO via portal settings:

- `POST /v1/portal/sso-connections` (create, ownerRequired)
- `GET /v1/portal/sso-connections` (list, ownerRequired)
- `PATCH /v1/portal/sso-connections/:id` (update, ownerRequired)
- `DELETE /v1/portal/sso-connections/:id` (delete, ownerRequired)

The `client_secret` is encrypted at rest using the existing tenant-scoped AES-256-GCM encryption (same pattern as provider API keys: `encrypted:{ciphertext}:{iv}`).

### 2.6 Library Choice

Use `openid-client` (certified OIDC Relying Party library for Node.js). It handles discovery, PKCE, token exchange, and ID token validation. The library supports all standard OIDC providers without provider-specific code paths.

### 2.7 Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/v1/portal/auth/sso/authorize` | GET | None | Initiate SSO flow (redirect to IdP) |
| `/v1/portal/auth/sso/callback` | GET | None | Handle IdP callback, issue JWT |
| `/v1/portal/sso-connections` | POST | sessionAuth + ownerRequired | Create SSO connection |
| `/v1/portal/sso-connections` | GET | sessionAuth + ownerRequired | List SSO connections |
| `/v1/portal/sso-connections/:id` | PATCH | sessionAuth + ownerRequired | Update SSO connection |
| `/v1/portal/sso-connections/:id` | DELETE | sessionAuth + ownerRequired | Delete SSO connection |

------------------------------------------------------------------------

## 3. RBAC Formalization

### 3.1 Current State

Authorization checks are ad-hoc. The portal auth middleware accepts an optional `requiredRole` parameter (`'owner'` or `'member'`), and route registrations use either `authRequired` (any authenticated user) or `ownerRequired` (owner role check). There is no permission model: the two roles are just strings compared in middleware.

```typescript
// Current pattern (src/routes/portal.ts)
const authRequired = registerPortalAuthMiddleware(fastify);
const ownerRequired = registerPortalAuthMiddleware(fastify, 'owner');

fastify.get('/v1/portal/me', { preHandler: authRequired }, ...);
fastify.patch('/v1/portal/settings', { preHandler: ownerRequired }, ...);
```

### 3.2 Permission Model

Define granular permissions organized by resource:

```typescript
// src/auth/permissions.ts

export const PERMISSIONS = {
  // Tenant-scoped
  'agents:read':          'View agent configurations',
  'agents:write':         'Create, update, delete agents',
  'keys:read':            'View API keys (prefix only)',
  'keys:manage':          'Create, revoke, rotate API keys',
  'members:read':         'View tenant members',
  'members:invite':       'Send invitations',
  'members:manage':       'Change member roles, remove members',
  'settings:read':        'View tenant settings',
  'settings:write':       'Update tenant settings (provider config, SSO)',
  'traces:read':          'View traces and analytics',
  'kb:read':              'View knowledge bases',
  'kb:write':             'Create, update, delete knowledge bases',
  'deployments:read':     'View deployments',
  'deployments:manage':   'Create, promote, rollback deployments',
  'conversations:read':   'View conversation history',

  // Platform-scoped (superadmin only)
  'tenants:read':         'View all tenants (cross-tenant)',
  'tenants:manage':       'Create, deactivate tenants',
  'system:analytics':     'View system-wide analytics',
  'system:config':        'Manage platform settings',
  'system:users':         'Manage all users',
} as const;

export type Permission = keyof typeof PERMISSIONS;
```

### 3.3 Role-to-Permission Mapping

```typescript
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  member: [
    'agents:read',
    'keys:read',
    'members:read',
    'settings:read',
    'traces:read',
    'kb:read',
    'deployments:read',
    'conversations:read',
  ],

  owner: [
    // Everything member has, plus write access
    'agents:read', 'agents:write',
    'keys:read', 'keys:manage',
    'members:read', 'members:invite', 'members:manage',
    'settings:read', 'settings:write',
    'traces:read',
    'kb:read', 'kb:write',
    'deployments:read', 'deployments:manage',
    'conversations:read',
  ],

  superadmin: [
    // Everything owner has, plus platform-scoped
    // (all tenant-scoped permissions are implicitly granted for any tenant)
    'tenants:read', 'tenants:manage',
    'system:analytics', 'system:config', 'system:users',
  ],
};
```

Superadmins inherit all tenant-scoped permissions for any tenant they access. This is handled in the middleware: if `platformRole === 'superadmin'`, the permission check passes for any tenant-scoped permission.

### 3.4 Middleware

```typescript
// src/middleware/requirePermission.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ROLE_PERMISSIONS, Permission } from '../auth/permissions.js';

export function requirePermission(...required: Permission[]) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.sessionUser;
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Superadmins pass all permission checks
    if (user.platformRole === 'superadmin') return;

    const rolePerms = ROLE_PERMISSIONS[user.role] ?? [];
    const missing = required.filter(p => !rolePerms.includes(p));

    if (missing.length > 0) {
      return reply.code(403).send({
        error: 'Insufficient permissions',
        required: missing,
      });
    }
  };
}
```

**Usage in routes (replacing ad-hoc checks):**

```typescript
// Before
fastify.patch('/v1/portal/settings', { preHandler: ownerRequired }, handler);

// After
fastify.patch('/v1/portal/settings', {
  preHandler: [sessionAuth, requirePermission('settings:write')]
}, handler);
```

### 3.5 Registry Scope Alignment

The existing registry scopes (`weave:write`, `registry:push`, `deploy:write`, `artifact:read`, `runtime:access`) map directly into the RBAC permission model. The `scopes` array in the JWT serves double duty: it carries both registry scopes (for CLI operations) and can carry tenant permissions for session tokens. The `TENANT_OWNER_SCOPES` and `TENANT_MEMBER_SCOPES` constants in `src/auth/registryScopes.ts` remain unchanged but are generated from the same role-permission mapping.

### 3.6 Custom Roles (Stretch Goal)

For Phase 2, allow tenant owners to define custom roles with configurable permission sets:

```sql
CREATE TABLE tenant_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  permissions TEXT[] NOT NULL,    -- array of permission strings
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
```

Custom roles would be resolved at login time and their permissions injected into the JWT `scopes` array. The `requirePermission` middleware already works with any permission set, so no middleware changes are needed.

------------------------------------------------------------------------

## 4. Dashboard Merge into Portal

### 4.1 Current State

The dashboard is a separate React SPA (`dashboard/` directory) built with Vite and served at `/dashboard` via `@fastify/static`. Its API routes (`/v1/traces`, `/v1/analytics/*`) use gateway API key auth (the global preHandler in `src/auth.ts` populates `request.tenant`).

The portal already has its own analytics and trace endpoints (`/v1/portal/traces`, `/v1/portal/analytics/*`) that duplicate the dashboard endpoints but use portal JWT auth.

### 4.2 Target State

1. **Remove `dashboard/` build target.** Dashboard views (traces, analytics charts) become routes within the portal SPA.
2. **Remove `/dashboard` static mount** from `src/index.ts`.
3. **Remove SPA fallback** for `/dashboard/*` URLs in `setNotFoundHandler`.
4. **Deprecate `/v1/traces` and `/v1/analytics/*`** gateway-auth endpoints (keep for one release with deprecation header, then remove). The portal endpoints become the canonical API.
5. **Add superadmin analytics routes:** New portal endpoints for cross-tenant system analytics:

```
GET /v1/portal/system/analytics/summary     (requirePermission('system:analytics'))
GET /v1/portal/system/analytics/timeseries  (requirePermission('system:analytics'))
GET /v1/portal/system/analytics/models      (requirePermission('system:analytics'))
GET /v1/portal/system/tenants               (requirePermission('tenants:read'))
```

### 4.3 Frontend Changes

The portal SPA gains new navigation items visible based on permissions:

| Nav Item | Visible To | Route |
|----------|-----------|-------|
| Traces | owner, member (with `traces:read`) | `/traces` |
| Analytics | owner, member (with `traces:read`) | `/analytics` |
| System Overview | superadmin | `/system` |
| Tenant Management | superadmin | `/system/tenants` |

### 4.4 Affected Files

- `dashboard/` (entire directory removed after migration)
- `portal/src/` (add system analytics pages, navigation updates)
- `src/index.ts` (remove dashboard static mount, remove dashboard SPA fallback)
- `src/routes/dashboard.ts` (mark deprecated, schedule removal)
- `src/routes/portal.ts` (add system analytics routes for superadmins)

------------------------------------------------------------------------

## 5. Migration Plan

### 5.1 Database Migrations (Sequenced)

**Migration 1: Add columns to `users` table**

```sql
ALTER TABLE users
  ADD COLUMN platform_role VARCHAR(20) NOT NULL DEFAULT 'user',
  ADD COLUMN display_name VARCHAR(255),
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sso_provider VARCHAR(100),
  ADD COLUMN sso_subject  VARCHAR(255);

CREATE UNIQUE INDEX idx_users_sso
  ON users (sso_provider, sso_subject)
  WHERE sso_provider IS NOT NULL;
```

**Migration 2: Migrate admin users into users table**

```sql
INSERT INTO users (id, email, password_hash, platform_role, must_change_password, created_at, last_login)
SELECT
  id,
  username || '@platform.local',
  password_hash,
  'superadmin',
  must_change_password,
  created_at,
  last_login
FROM admin_users
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE users.id = admin_users.id
);
```

**Migration 3: Create `sso_connections` table**

(See schema in section 2.1)

**Migration 4 (deferred): Drop `admin_users` table**

```sql
DROP TABLE admin_users;
```

### 5.2 Code Migration (Phased)

**Phase A: Unified Auth Middleware (non-breaking)**
1. Create `src/middleware/sessionAuth.ts` with the unified middleware.
2. Create `src/auth/permissions.ts` with the permission model and role mappings.
3. Create `src/middleware/requirePermission.ts`.
4. Update `UserManagementService` to issue JWTs with `platformRole` in payload.
5. Update `User` entity and schema with new fields.

**Phase B: Route Migration (breaking for admin, backward-compatible for portal)**
1. Update portal routes: swap `authRequired`/`ownerRequired` to `sessionAuth` + `requirePermission`.
2. Update admin routes: swap `adminAuthMiddleware` to `[sessionAuth, requireSuperadmin]`.
3. Add SSO routes and `SsoConnection` entity/schema.

**Phase C: Dashboard Merge**
1. Move dashboard-specific UI components into portal SPA.
2. Add system analytics portal routes for superadmins.
3. Deprecate `/v1/traces` and `/v1/analytics/*` with `Deprecation` response header.
4. Remove `/dashboard` static mount from `src/index.ts`.

**Phase D: Cleanup**
1. Remove `src/middleware/portalAuth.ts` and `src/middleware/adminAuth.ts`.
2. Remove `dashboard/` directory.
3. Remove `AdminUser` entity and schema.
4. Run migration to drop `admin_users` table.

### 5.3 Transition Window

During the transition window (one release cycle):

- Both `PORTAL_JWT_SECRET` and `AUTH_JWT_SECRET` are accepted. If both are set, `AUTH_JWT_SECRET` takes precedence.
- The admin login endpoint (`POST /v1/admin/auth/login`) continues to work but issues a unified JWT and logs a deprecation warning.
- Dashboard API endpoints (`/v1/traces`, `/v1/analytics/*`) continue to work with API key auth but return a `Deprecation: true` header.

------------------------------------------------------------------------

## 6. Security Considerations

### 6.1 Secret Rotation

Moving from multiple secrets to one increases the blast radius of a secret compromise. Mitigations:

- Support `AUTH_JWT_SECRET_PREVIOUS` env var for zero-downtime rotation. The middleware attempts verification with the current secret first, then falls back to the previous secret.
- Runtime JWTs retain an independent override (`RUNTIME_JWT_SECRET`) since they are long-lived deployment tokens with a different threat model.

### 6.2 SSO Security

- **PKCE required** for all authorization code flows (prevents code interception attacks).
- **State parameter** stored in a server-side session store (or signed cookie) to prevent CSRF.
- **ID token validation:** Verify issuer, audience, expiry, nonce, and signature per OIDC Core specification.
- **Client secret encryption:** Stored encrypted at rest using the existing per-tenant AES-256-GCM scheme.
- **SSO enforcement bypass:** Only superadmins can log in with password when SSO enforcement is active for a tenant.

### 6.3 Permission Escalation Prevention

- The `platformRole` claim in the JWT is set at login time from the `users.platform_role` column. It cannot be self-modified by the user.
- Tenant-switching (`POST /v1/portal/auth/switch-tenant`) re-issues a JWT with the new tenant's role from the `tenant_memberships` table. A user cannot claim `owner` on a tenant where they are a `member`.
- Custom roles (stretch goal) are validated server-side: the JWT `scopes` array is rebuilt from the role's permission set at login time, not from client input.

### 6.4 Rate Limiting

SSO callback endpoints should be rate-limited to prevent token exchange abuse:

- `/v1/portal/auth/sso/callback`: 10 requests per minute per IP.
- SSO authorization endpoint: 20 requests per minute per IP (user-initiated).

------------------------------------------------------------------------

## 7. Testing Plan

### 7.1 Unit Tests

| Test Area | Strategy |
|-----------|----------|
| `sessionAuth` middleware | Mock JWT verification, test payload extraction, test expired/invalid tokens |
| `requirePermission` middleware | Mock `sessionUser`, test each role against each permission, test superadmin bypass |
| `requireSuperadmin` middleware | Verify 403 for non-superadmin, pass-through for superadmin |
| RBAC role-permission mapping | Verify `owner` has all `member` permissions plus write permissions |
| SSO user provisioning | Mock `EntityManager`, test find-or-create logic for new users, existing users, and SSO-linked users |
| SSO enforcement | Mock tenant with `enforce_sso = true`, verify password login returns 403 |
| Admin user migration service | Verify `admin_users` rows are correctly mapped to `users` with `platform_role = 'superadmin'` |

### 7.2 Integration Tests (SQLite)

| Test Area | Strategy |
|-----------|----------|
| User entity with new fields | Create user with `platform_role`, verify persistence and retrieval |
| `SsoConnection` entity | CRUD operations, verify encryption of `client_secret` |
| JWT issuance with unified payload | Login, verify JWT contains `platformRole`, `scopes`, `orgSlug` |
| Tenant switching with RBAC | Switch tenant, verify new JWT has correct role and permissions |
| Admin route access via session JWT | Verify superadmin can access `/v1/admin/*`, regular user gets 403 |

### 7.3 Smoke Tests (Playwright)

| Test Area | Strategy |
|-----------|----------|
| Portal login and dashboard views | Login as owner, navigate to traces and analytics pages |
| Superadmin system view | Login as superadmin, verify system analytics page loads |
| SSO flow (mock IdP) | Use a test OIDC provider to verify the full redirect/callback flow |
| Permission-gated UI elements | Login as member, verify write actions are hidden or disabled |

### 7.4 Backward Compatibility Tests

| Test Area | Strategy |
|-----------|----------|
| Old portal JWTs | Verify JWTs signed with `PORTAL_JWT_SECRET` still work during transition |
| Old admin JWTs | Verify `/v1/admin/*` routes accept old-format admin JWTs during transition |
| Dashboard API endpoints | Verify `/v1/traces` still works with API key auth but returns `Deprecation` header |
| Registry CLI operations | Verify CLI push/deploy with existing JWTs continues to work |

------------------------------------------------------------------------

## 8. Open Questions

1. **Admin user email mapping:** When migrating `admin_users` to `users`, what email domain should be used? Options: (a) `username@platform.local`, (b) require manual email assignment before migration, (c) prompt on first login.

2. **SSO session management:** Should SSO-authenticated sessions have a different expiry than password sessions? Some enterprises expect shorter session lifetimes for SSO.

3. **Multiple SSO per tenant:** The current schema has `UNIQUE (tenant_id, provider_type)`, limiting one connection per provider type per tenant. Should we allow multiple connections of the same type (e.g., two Azure AD tenants)?

4. **Superadmin tenant context:** When a superadmin accesses a tenant they are not a member of, what `tenantId` goes in their JWT? Options: (a) a synthetic "platform" tenant, (b) no `tenantId` for cross-tenant operations, (c) the superadmin's "home" tenant with tenant override via query parameter.

5. **Token refresh:** The current system uses short-lived JWTs with no refresh token mechanism. Should this spec include refresh tokens? Recommendation: defer to a separate spec.

6. **Dashboard deprecation timeline:** How long should the `/v1/traces` and `/v1/analytics/*` gateway-auth endpoints remain available? Recommendation: two release cycles with deprecation headers, then removal.

7. **Custom roles timeline:** Should custom roles be included in the initial implementation or deferred? Recommendation: defer to Phase 2.
