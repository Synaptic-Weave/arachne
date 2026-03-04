# Session Log: Tenant Portal Implementation

**Date:** 2026-02-26T15:57:42Z  
**Topic:** Tenant Self-Service Portal (Backend + Frontend)  
**Agents Involved:** Fenster, McManus  
**Status:** ✅ Complete

---

## Summary

Built complete tenant self-service portal: signup, login, provider config, and API key management. Backend (Fenster) implemented 7 routes + migration + auth middleware. Frontend (McManus) scaffolded React SPA with 6 pages, 4 components, and API client. All 113 tests passing.

---

## Deliverables

**Backend (Fenster):**
- Migration `1000000000010_create-tenant-users` table
- Routes: signup, login, me, settings, api-keys (list/create/delete)
- Auth middleware with separate JWT namespace
- Encryption reuse for LLM provider keys
- SPA fallback routing

**Frontend (McManus):**
- React SPA scaffold: `portal/` directory
- Pages: Landing, Login, Signup, Dashboard, Settings, API Keys
- Components: AuthGuard, AppLayout, ApiKeyReveal, ProviderConfigForm
- API client + auth utilities
- Build scripts: `build:portal`, `build:all`

---

## Key Decisions

1. **Email globally unique** — One email = one tenant_user (can extend to multi-tenant-per-user later if needed)
2. **Portal JWT isolated** — Separate from admin JWT via Fastify namespace; uses `decoratorName: 'portalJwt'`
3. **API key prefix = 15 chars** — `loom_sk_` + 7 base64url (follows Keaton's spec exactly)
4. **Scrypt passwords** — Consistent format with admin_users: `salt:derivedKey`
5. **SPA fallback logic** — Portal served at root `/`; checks `/v1/` and `/dashboard` prefixes before fallback
6. **Rate limiting TODO** — Added comments in signup/login; not blocking v1 but address before public launch

---

## Cross-Team Items

- Keaton: Rate limiting recommendation; `docker-compose.yml` `PORTAL_JWT_SECRET` var
- Hockney: Integration test coverage for signup/login flows, encryption, atomicity
