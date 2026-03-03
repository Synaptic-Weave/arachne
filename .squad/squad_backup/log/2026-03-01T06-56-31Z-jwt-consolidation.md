# Session: JWT Auth Consolidation

**Date:** 2026-03-01  
**Duration:** Single agent run (Fenster)

## Goal

Replace two separate JWT implementations (admin: @fastify/jwt, portal: fast-jwt) with a single shared approach using `jsonwebtoken` directly.

## Outcome

✅ Consolidation complete.

- `src/auth/jwtUtils.ts` (new) — signJwt/verifyJwt wrappers
- `src/middleware/createBearerAuth.ts` (new) — shared Bearer factory
- adminAuth.ts, portalAuth.ts rewritten
- Removed: @fastify/jwt, fast-jwt
- Added: jsonwebtoken + @types/jsonwebtoken
- 512 tests passing

## Key Decision

Use `jsonwebtoken` directly (no framework coupling), with shared preHandler factory for auth. JWT secrets remain separate (ADMIN_JWT_SECRET, PORTAL_JWT_SECRET).
