# Kujan — History

## Project Context

**Project:** Arachne — provider-agnostic AI gateway and developer platform
**Tech stack:** Node.js / TypeScript, Fastify 5, MikroORM 6, PostgreSQL, React/Vite portal, Commander.js CLI
**Owner:** Michael Brown (michaelbrown)
**GitHub:** Goalglowup/loom

## Architecture

- Gateway: Fastify 5, port 3000, Docker image via Dockerfile at repo root
- Portal: React/Vite SPA, served from Dockerfile.portal
- CLI: @arachne/cli, npm package
- Service topology:
  - arachne-ai.com → Azure Static Web Apps (portal)
  - api.arachne-ai.com → Azure Container Apps (gateway, port 3000)
  - registry.arachne-ai.com → same Container App, second custom domain

## Learnings

- Hired 2026-03-02 for Beta Launch — owns all Terraform and CI/CD work
- 2026-03-02: Created `.github/workflows/ci.yml` — PR checks on `main` and `dev`; parallel `test` (vitest + build root + cli) and `lint` jobs; Node 20, `actions/checkout@v4`, `actions/setup-node@v4` with npm cache
- 2026-03-02: Created `.github/workflows/publish.yml` — pushes Docker images to GHCR on merge to `main`; builds `arachne-gateway` (Dockerfile) and `arachne-portal` (Dockerfile.portal); tagged `:latest` and `:<sha>`; requires packages to be set public manually in GitHub Settings → Packages
- 2026-03-02: Created `terraform/` directory — Azure Container Apps infra for beta launch. Files: `main.tf` (provider + core vars), `resources.tf` (resource group, log analytics workspace, container app environment, gateway + portal container apps), `variables.tf` (all vars with descriptions/defaults/sensitive flags), `outputs.tf` (gateway_url, portal_url). Database intentionally omitted — manual provision for beta, Terraform in v2. Gateway: external ingress port 3000, min 1 / max 3 replicas, secrets for DATABASE_URL / MASTER_KEY / JWT_SECRET / ADMIN_JWT_SECRET, SIGNUPS_ENABLED=false. Portal: external ingress port 80, min 1 / max 2 replicas.
- 2026-03-02: Created `.github/workflows/deploy.yml` — triggered via `workflow_run` on "Publish Docker Images" completion; only runs if publish succeeded; uses `azure/login@v2` with `AZURE_CREDENTIALS` secret; updates gateway and portal container apps via `az containerapp update` with SHA-tagged images; resource group from `vars.AZURE_RESOURCE_GROUP`.

## Learnings

- `workflow_run` trigger is cleanest way to chain publish → deploy; avoids duplicate triggers and keeps separation of concerns
- Azure Container Apps secrets declared as `secret {}` blocks on the resource and referenced via `secret_name` in env blocks — not plain env vars
- `sensitive = true` on Terraform variables prevents values appearing in plan output
- For beta: keep Terraform minimal (no Key Vault, no PostgreSQL) — reduces blast radius and ops overhead; add in v2 once stable
- Image override pattern (var non-empty check) lets CI pass exact SHA tags while `terraform plan` works with a default `:latest` for local dev

---

### Beta Launch Sprint — Epic #70 Completion

**Wave 1 DevOps — Issues #85, #86 (COMPLETED)**
- **#85 CI workflow:** Implemented `.github/workflows/ci.yml` with parallel test + lint jobs on PR to main/dev
- **#86 Publish workflow:** Implemented `.github/workflows/publish.yml` with GHCR auth, dual-image build (gateway + portal), `:latest` + `:sha` tags

**Wave 2 Infra — Issues #87, #88 (COMPLETED)**
- **#87 Terraform Azure:** Provisioned Container Apps for gateway + portal, env config, SIGNUPS_ENABLED=false
- **#88 Deploy workflow:** Implemented `.github/workflows/deploy.yml` with `workflow_run` trigger, `az containerapp update`

**Cross-team coordination:**
- Frontend (McManus) & backend (Fenster) changes tested in CI before merge
- Images built and pushed to GHCR on every main push
- Deploy waits for publish completion to avoid race condition
- Terraform exports all critical secrets via `TF_VAR_*` env vars (Key Vault deferred to v2)
- Database provisioned manually (terraform import in v2)

**Key decisions captured:**
- CI triggers on PR; publish on push-to-main only
- workflow_run ensures GHCR images exist before deploy
- No build matrix (Node 20 single target)
- Gateway: 0.5 CPU/1GiB; Portal: 0.25 CPU/0.5GiB resource asymmetry
- SIGNUPS_ENABLED hardcoded=false in Terraform (invite-only beta)

**Impact:** Full CI/CD pipeline ready for beta launch. Infra scales from image build to Azure deployment with safety guards.


### PostgreSQL + Azurerm Backend ($(date +%Y-%m-%d))
- Added `azurerm_postgresql_flexible_server` resource (`B_Standard_B1ms`, PG 15, 32 GB) to `resources.tf`
- Added `azurerm_postgresql_flexible_server_database` for database named `arachne` (UTF8 / en_US.utf8)
- Added `db_admin_password` sensitive variable to `variables.tf`
- Added sensitive `database_url` output to `outputs.tf` constructed from server FQDN + credentials
- Replaced stale "provision manually" comment in `resources.tf` with actual TF resources
- Added `backend "azurerm"` block to `terraform {}` in `main.tf` with placeholder values overrideable via `-backend-config` at init time
- Added bootstrap CLI comment in `main.tf` for creating the TF state storage account (chicken-and-egg pattern — not managed by this TF config)
- Refactored flat `resources.tf` into 4 modules: `observability`, `keyvault`, `database`, `container_apps`
- Added Azure Key Vault (`azurerm_key_vault`) with user-assigned managed identity; deployer gets full CRUD access, app identity gets read-only
- DB admin password is now auto-generated via `random_password` inside the keyvault module — no longer a manual input variable
- Container App gateway secrets now use `key_vault_secret_id` + managed identity instead of inline plaintext values (requires azurerm ≥ 3.87.0)
- `database_url` KV secret is created as a root-level resource (not inside either module) to avoid circular dependency: keyvault module generates the DB password, database module produces the FQDN, root stitches them together
- Removed `database_url` and `db_admin_password` from root `variables.tf` — both are now derived automatically
- Bumped azurerm provider constraint from `~> 3.0` to `~> 3.87` to unlock `key_vault_secret_id` on Container App secret blocks
- Added `random` provider `~> 3.0` to root terraform block (forwarded to keyvault module which also declares it)

- 2026-03-02: Fixed local dev Postgres image from `postgres:16-alpine` to `pgvector/pgvector:pg16` — pgvector extension required for migration 015 (kb_chunks embeddings with vector storage)

---

## 2026-03-03: Beta Signup Proxy Fix (#97) — Docker & Dev Environment

**Issue:** Developers running migrations locally failed due to missing pgvector extension.

**Fix:**
- Updated `docker-compose.yml` postgres service image from `postgres:16-alpine` to `pgvector/pgvector:pg16`
- Updated `RUNNING_LOCALLY.md` to reflect pgvector requirement

**Why:** Migration 015 adds kb_chunks table with `embedding` column (vector type). Alpine postgres image doesn't include pgvector extension; migrations fail with "type \"vector\" does not exist".

**Impact:** All developers can now run full migration suite locally without manual extension installation. pgvector/pgvector image is production-ready (based on official postgres:16).

**Decision:** Documented in `.squad/decisions.md` under "Local Dev Postgres Image Must Be pgvector/pgvector:pg16"
