# Multi-Provider Management System Architecture

**Version:** 1.0
**Date:** 2026-03-06
**Status:** Approved

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture](#current-architecture)
3. [Problem Statement](#problem-statement)
4. [Proposed Architecture](#proposed-architecture)
5. [Database Schema](#database-schema)
6. [API Specifications](#api-specifications)
7. [User Stories](#user-stories)
8. [Implementation Plan](#implementation-plan)
9. [Testing Strategy](#testing-strategy)
10. [Security Considerations](#security-considerations)

---

## Executive Summary

This document describes the refactoring of Arachne's provider configuration system from untyped JSONB fields to a proper entity-based architecture supporting both gateway-managed providers and tenant custom "bring your own key" (BYOK) providers.

### Goals

- **Gateway Providers**: Admin-configured infrastructure available to all tenants (credentials hidden)
- **Custom Providers**: Multi-tenant BYOK with full control and visibility
- **Model Enforcement**: API-level validation against provider's available models
- **Agent Portability**: Export/import without provider coupling
- **Cache Fix**: Resolve provider caching invalidation bug

### Key Benefits

1. **Multi-tenant Infrastructure**: Admins provide shared LLM access
2. **Flexibility**: Tenants can use gateway providers OR their own keys
3. **Cost Control**: Model restrictions prevent expensive API calls
4. **Portability**: Agents work across self-hosted, local, and public gateways
5. **Type Safety**: Replace JSONB with proper entities and relationships

---

## Current Architecture

### Provider Storage (JSONB)

Currently, provider configuration is stored as untyped JSONB directly on entities:

```typescript
// Tenant Entity
class Tenant {
  providerConfig: any | null;  // JSONB: { provider, apiKey, baseUrl, ... }
}

// Agent Entity
class Agent {
  providerConfig: any | null;  // JSONB: { provider, apiKey, baseUrl, ... }
}
```

### Current Resolution

```
Agent.providerConfig
  → Tenant.providerConfig
  → Parent Tenant chain (up to 10 hops)
  → process.env.OPENAI_API_KEY
```

### Current Limitations

1. **No entity**: Provider configs are untyped JSONB blobs
2. **Tenant-scoped only**: No system-wide providers
3. **Cache bug**: Updating agent providerConfig doesn't evict provider cache
4. **No UI**: Can't select providers for agents in portal
5. **No model restrictions**: Any model string accepted
6. **Tight coupling**: Agent exports include provider credentials

---

## Problem Statement

### Issues Identified

1. **Provider Cache Bug**
   - Location: `TenantManagementService.updateAgent()` (line ~199)
   - Issue: Missing `evictProvider(agentId)` call after agent update
   - Impact: Configuration changes don't take effect until server restart

2. **No Multi-Tenant Infrastructure**
   - Admins can't provide shared LLM access to all tenants
   - Every tenant must configure their own API keys
   - No way to offer "free tier" with gateway-provided models

3. **No Model Restrictions**
   - Any model string accepted at API level
   - No validation against provider capabilities
   - Risk of expensive API calls (e.g., GPT-4 when only 3.5 intended)

4. **Agent Portability Issues**
   - Exported agent specs include provider configuration
   - Can't move agents between gateways (self-hosted ↔ public ↔ local)
   - Provider settings tied to specific gateway infrastructure

5. **Type Safety**
   - JSONB fields have no compile-time validation
   - Errors only discovered at runtime
   - Difficult to refactor or add provider types

---

## Proposed Architecture

### Provider Entity

```typescript
class Provider {
  id: string;                      // UUID primary key
  name: string;                    // "Azure GPT-4", "My OpenAI Key"
  description: string | null;      // User-friendly description
  type: 'openai' | 'azure' | 'ollama';

  // Scoping
  tenantId: string | null;         // NULL = gateway provider
  isDefault: boolean;              // Only one gateway provider can be default

  // Configuration (hidden for gateway providers)
  apiKey: string;                  // Encrypted: "encrypted:{ciphertext}:{iv}"
  baseUrl: string | null;
  deployment: string | null;       // Azure-specific
  apiVersion: string | null;       // Azure-specific

  // Model restrictions (enforced at API)
  availableModels: string[];       // ["gpt-4o", "gpt-4o-mini"]

  createdAt: Date;
  updatedAt: Date;
}
```

### Updated Entities

```typescript
// Agent: Runtime configuration (NOT in exportable spec)
class Agent {
  providerId: string | null;       // FK to Provider (NULL = inherit)
  model: string | null;            // NULL = inherit
  suggestedModels: string[];       // Exportable: guidance for import
  // ... existing fields
}

// Tenant: Org-level defaults
class Tenant {
  defaultProviderId: string | null;  // FK to Provider (NULL = gateway default)
  // ... existing fields
}
```

### Provider Resolution Chain

```
Agent.provider
  ↓ (if null)
Tenant.defaultProvider
  ↓ (if null)
Provider.findOne({ tenantId: null, isDefault: true })  // Gateway default
```

### Provider Types

#### 1. Gateway Providers
- **Created by**: Gateway admins only
- **Scoping**: `tenantId = NULL`
- **Visibility**: All tenants see name/description/models (credentials hidden)
- **Use case**: Shared infrastructure, free tier, cost control
- **Example**: "Azure GPT-4 - General Purpose"

#### 2. Custom Providers (BYOK)
- **Created by**: Tenant owners
- **Scoping**: `tenantId = <tenant-uuid>`
- **Visibility**: Full configuration details visible to tenant
- **Use case**: Bring your own API key, specialized endpoints
- **Example**: "My OpenAI Production Key"

---

## Database Schema

### Providers Table

```sql
CREATE TABLE providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL CHECK (type IN ('openai', 'azure', 'ollama')),

  -- Scoping
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = gateway provider
  is_default BOOLEAN NOT NULL DEFAULT false,

  -- Configuration
  api_key TEXT NOT NULL,                    -- Encrypted
  base_url TEXT,
  deployment VARCHAR(255),                   -- Azure
  api_version VARCHAR(50),                   -- Azure

  -- Model restrictions
  available_models TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_providers_tenant_id ON providers(tenant_id);
CREATE INDEX idx_providers_is_default ON providers(is_default) WHERE tenant_id IS NULL;

-- Constraints
CREATE UNIQUE INDEX idx_providers_tenant_name ON providers(tenant_id, name);

-- Only one gateway provider can be default
CREATE UNIQUE INDEX idx_providers_gateway_default
  ON providers(is_default)
  WHERE tenant_id IS NULL AND is_default = true;
```

### Agents Table Updates

```sql
ALTER TABLE agents
  ADD COLUMN provider_id UUID REFERENCES providers(id) ON DELETE SET NULL,
  ADD COLUMN suggested_models TEXT[] DEFAULT '{}';

CREATE INDEX idx_agents_provider_id ON agents(provider_id);

-- Later: Drop old JSONB column
ALTER TABLE agents DROP COLUMN provider_config;
```

### Tenants Table Updates

```sql
ALTER TABLE tenants
  ADD COLUMN default_provider_id UUID REFERENCES providers(id) ON DELETE SET NULL;

CREATE INDEX idx_tenants_default_provider_id ON tenants(default_provider_id);

-- Later: Drop old JSONB column
ALTER TABLE tenants DROP COLUMN provider_config;
```

---

## API Specifications

### Admin Provider Endpoints

#### List Gateway Providers
```http
GET /v1/admin/providers
Authorization: Bearer <admin-token>

Response 200:
[
  {
    "id": "uuid",
    "name": "Azure GPT-4",
    "description": "Production Azure deployment",
    "type": "azure",
    "isDefault": true,
    "apiKey": "encrypted:...",  // Full details for admin
    "baseUrl": "https://...",
    "deployment": "gpt-4",
    "apiVersion": "2024-02-15",
    "availableModels": ["gpt-4o", "gpt-4o-mini"],
    "createdAt": "2026-03-06T10:00:00Z",
    "updatedAt": "2026-03-06T10:00:00Z"
  }
]
```

#### Create Gateway Provider
```http
POST /v1/admin/providers
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Azure GPT-4",
  "description": "Production Azure deployment",
  "type": "azure",
  "apiKey": "sk-...",
  "baseUrl": "https://my-resource.openai.azure.com",
  "deployment": "gpt-4",
  "apiVersion": "2024-02-15",
  "availableModels": ["gpt-4o", "gpt-4o-mini"]
}

Response 201:
{
  "id": "uuid",
  "name": "Azure GPT-4",
  // ... full provider details
}
```

#### Update Gateway Provider
```http
PUT /v1/admin/providers/:id
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Azure GPT-4 Updated",
  "availableModels": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]
}

Response 200:
{
  "id": "uuid",
  // ... updated provider
}
```

#### Delete Gateway Provider
```http
DELETE /v1/admin/providers/:id
Authorization: Bearer <admin-token>

Response 204: No Content
```

#### Set Gateway Default
```http
POST /v1/admin/providers/:id/default
Authorization: Bearer <admin-token>

Response 200:
{
  "id": "uuid",
  "isDefault": true,
  // ... provider details
}
```

### Portal Provider Endpoints

#### List Available Providers
```http
GET /v1/portal/providers
Authorization: Bearer <portal-token>

Response 200:
{
  "gateway": [
    {
      "id": "uuid",
      "name": "Azure GPT-4",
      "description": "Production Azure deployment",
      "type": "azure",
      "isDefault": true,
      "availableModels": ["gpt-4o", "gpt-4o-mini"]
      // NOTE: No apiKey, baseUrl, deployment (sanitized)
    }
  ],
  "custom": [
    {
      "id": "uuid",
      "name": "My OpenAI Key",
      "description": "Personal API key",
      "type": "openai",
      "apiKey": "encrypted:...",  // Full details (tenant owns this)
      "baseUrl": null,
      "availableModels": []
    }
  ]
}
```

#### Create Custom Provider
```http
POST /v1/portal/providers
Authorization: Bearer <portal-token>
Content-Type: application/json

{
  "name": "My OpenAI Key",
  "description": "Personal API key",
  "type": "openai",
  "apiKey": "sk-...",
  "availableModels": ["gpt-4", "gpt-3.5-turbo"]
}

Response 201:
{
  "id": "uuid",
  // ... full provider details
}
```

#### Update Custom Provider
```http
PUT /v1/portal/providers/:id
Authorization: Bearer <portal-token>

{
  "availableModels": ["gpt-4", "gpt-3.5-turbo", "gpt-4-turbo"]
}

Response 200:
{
  // ... updated provider
}
```

#### Delete Custom Provider
```http
DELETE /v1/portal/providers/:id
Authorization: Bearer <portal-token>

Response 204: No Content

Response 400 (if in use):
{
  "error": "provider_in_use",
  "message": "Cannot delete provider that is in use by 3 agent(s)",
  "agentIds": ["uuid1", "uuid2", "uuid3"]
}
```

### Model Validation

#### Chat Request with Invalid Model
```http
POST /v1/chat/completions
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "model": "gpt-5",  // Not in provider's availableModels
  "messages": [...]
}

Response 400:
{
  "error": "model_not_available",
  "message": "Model 'gpt-5' is not available for provider 'Azure GPT-4'",
  "provider": {
    "id": "uuid",
    "name": "Azure GPT-4"
  },
  "availableModels": ["gpt-4o", "gpt-4o-mini"]
}
```

---

## User Stories

### Epic: Multi-Provider Management System

**Goal:** Enable gateway providers and tenant custom providers with model restrictions and agent portability.

---

### Story 1: Provider Entity Foundation + Cache Fix

**As a** system architect
**I want** a proper Provider entity with database migrations
**So that** provider configuration is type-safe and well-structured

#### Acceptance Criteria
- [ ] Provider entity created with all fields
- [ ] Provider schema configured for MikroORM
- [ ] Migration creates providers table with indexes
- [ ] Migration seeds gateway default from env vars
- [ ] Cache eviction bug fixed in TenantManagementService
- [ ] Provider registry cache uses providerId as key
- [ ] Tests verify entity creation and cache behavior

---

### Story 2: Gateway Provider Management (Admin)

**As a** gateway administrator
**I want** to manage gateway providers through admin dashboard
**So that** I can provide shared infrastructure to all tenants

#### Acceptance Criteria
- [ ] ProviderManagementService created with gateway methods
- [ ] Admin routes: GET/POST/PUT/DELETE /v1/admin/providers
- [ ] Admin route: POST /v1/admin/providers/:id/default
- [ ] Admin dashboard ProvidersPage lists all gateway providers
- [ ] Can create gateway provider with full configuration
- [ ] Can update gateway provider configuration
- [ ] Can set one provider as default (unsets others)
- [ ] Can delete unused gateway providers
- [ ] Tests verify all CRUD operations

---

### Story 3: Tenant Custom Provider Management

**As a** tenant owner
**I want** to create and manage multiple custom BYOK providers
**So that** I can use my own API keys and switch between them

#### Acceptance Criteria
- [ ] ProviderManagementService has tenant provider methods
- [ ] Portal routes: GET/POST/PUT/DELETE /v1/portal/providers
- [ ] GET returns {gateway: [], custom: []} with sanitization
- [ ] Portal ProvidersPage shows gateway (read-only) + custom (CRUD)
- [ ] Can create custom provider with full configuration
- [ ] Can update custom provider
- [ ] Cannot delete provider in use by agents
- [ ] Duplicate provider names rejected per tenant
- [ ] Tests verify tenant provider management

---

### Story 4: Agent Provider Selection + Model Validation

**As a** tenant member
**I want** to select a provider for my agent with model restrictions enforced
**So that** I can control infrastructure and prevent invalid model errors

#### Acceptance Criteria
- [ ] Agent entity has providerId (nullable FK) and suggestedModels
- [ ] Tenant entity has defaultProviderId (nullable FK)
- [ ] Migration adds foreign keys to agents/tenants tables
- [ ] TenantService resolves provider (agent → tenant → gateway)
- [ ] Chat handlers validate model against provider.availableModels
- [ ] Invalid model returns 400 with available models list
- [ ] AgentEditor has provider selector dropdown
- [ ] AgentEditor has model combobox filtered by provider
- [ ] AgentEditor has suggested models tag input
- [ ] Shows inheritance when providerId is null
- [ ] Tests verify resolution and validation

---

### Story 5: Tenant Default Provider Selection

**As a** tenant owner
**I want** to set a default provider for my organization
**So that** agents inherit the default unless overridden

#### Acceptance Criteria
- [ ] TenantManagementService supports updating defaultProviderId
- [ ] SettingsPage has provider selector dropdown
- [ ] Options: "(Use gateway default)" + gateway + custom
- [ ] Shows current selection and inheritance
- [ ] Links to "Manage Providers" page
- [ ] Agent with null providerId inherits tenant default
- [ ] Tenant with null defaultProviderId uses gateway default
- [ ] Tests verify complete inheritance chain

---

### Story 6: Agent Portability + Legacy Data Migration

**As a** user
**I want** agent specs to exclude provider configuration
**So that** agents are portable across different gateways

#### Acceptance Criteria
- [ ] Migration migrates JSONB providerConfig to Provider records
- [ ] Tenant providerConfig → custom Provider + defaultProviderId
- [ ] Agent providerConfig → custom Provider + providerId
- [ ] Duplicates handled (same config = reuse provider)
- [ ] Migration drops old JSONB columns
- [ ] Agent export excludes providerId and model
- [ ] Agent export includes suggestedModels
- [ ] Agent import leaves providerId/model null
- [ ] Import wizard prompts for provider + model selection
- [ ] Import shows suggestedModels as guidance
- [ ] Tests verify no data loss during migration
- [ ] Tests verify export/import workflow

---

### Story 7: Comprehensive Testing + Documentation

**As a** developer and user
**I want** comprehensive tests and documentation
**So that** the provider system is reliable and understandable

#### Acceptance Criteria
- [ ] Smoke tests: Admin creates gateway provider
- [ ] Smoke tests: Tenant creates custom provider
- [ ] Smoke tests: Agent selects provider, model validated
- [ ] Smoke tests: Inheritance chain works
- [ ] Smoke tests: Export/import maintains portability
- [ ] Integration tests: Full end-to-end workflows
- [ ] Performance tests: Cache invalidation efficiency
- [ ] Security tests: Gateway credentials hidden from tenants
- [ ] README updated with provider architecture
- [ ] API documentation complete
- [ ] User guides created (admin + tenant)
- [ ] Migration guide for self-hosted deployments

---

## Implementation Plan

### Story-by-Story Vertical Slices

Each story is implemented completely (backend + frontend + tests + docs) before moving to the next.

#### Story 1: Provider Entity Foundation (Week 1)
- Database: Entity, schema, migrations
- Service: Cache fix
- Tests: Unit + integration
- Docs: Architecture docs
- **Commit:** "feat: Add Provider entity foundation and fix cache invalidation"

#### Story 2: Gateway Provider Management (Week 1-2)
- Backend: ProviderManagementService + admin routes
- Frontend: Admin ProvidersPage
- Tests: API + smoke tests
- Docs: Admin API + user guide
- **Commit:** "feat: Gateway provider management for admins"

#### Story 3: Tenant Custom Providers (Week 2)
- Backend: Tenant provider methods + portal routes
- Frontend: Portal ProvidersPage
- Tests: API + smoke tests
- Docs: Portal API + user guide
- **Commit:** "feat: Tenant custom BYOK provider management"

#### Story 4: Agent Provider Selection (Week 2-3)
- Backend: Agent/Tenant updates + resolution + validation
- Frontend: AgentEditor updates
- Tests: Resolution + validation tests
- Docs: Agent configuration guide
- **Commit:** "feat: Agent provider selection with model validation"

#### Story 5: Tenant Defaults (Week 3)
- Backend: TenantManagementService updates
- Frontend: SettingsPage updates
- Tests: Inheritance tests
- Docs: Tenant settings guide
- **Commit:** "feat: Tenant default provider selection"

#### Story 6: Portability + Migration (Week 3-4)
- Backend: Data migration + export/import logic
- Frontend: Import wizard updates
- Tests: Migration + portability tests
- Docs: Migration guide
- **Commit:** "feat: Agent portability and legacy data migration"

#### Story 7: Testing + Docs (Week 4)
- Testing: Comprehensive test suite
- Docs: Polish all documentation
- **Commit:** "docs: Comprehensive provider system documentation and tests"

---

## Testing Strategy

### Unit Tests

1. **Provider Entity**
   - Creation, validation, serialization
   - Encryption/decryption of API keys

2. **ProviderManagementService**
   - CRUD operations for gateway providers
   - CRUD operations for tenant providers
   - Validation rules (unique names, default constraints)

3. **Provider Resolution**
   - Agent → Tenant → Gateway default chain
   - Null handling at each level

4. **Model Validation**
   - Model in available models: pass
   - Model not in available models: reject
   - Empty available models: allow all

5. **Cache Eviction**
   - Update agent provider: cache cleared
   - Update provider: cache cleared
   - Delete provider: cache cleared

### Integration Tests

1. **End-to-End Provider Creation**
   - Admin creates gateway provider
   - Appears in tenant provider list (sanitized)
   - Tenant creates agent using gateway provider
   - Request succeeds

2. **Inheritance Chain**
   - Agent with null providerId uses tenant default
   - Tenant with null defaultProviderId uses gateway default
   - Agent with explicit providerId overrides defaults

3. **Model Validation**
   - Request with valid model: succeeds
   - Request with invalid model: 400 error with list

4. **Data Migration**
   - Tenant with JSONB providerConfig migrates successfully
   - Agent with JSONB providerConfig migrates successfully
   - No data loss

### Smoke Tests (Playwright)

1. **Admin Provider Management**
   ```typescript
   it('admin can create gateway provider', async () => {
     // Login as admin
     // Navigate to providers page
     // Click "Create Provider"
     // Fill form: name, type, API key, models
     // Submit
     // Verify provider appears in list
   });
   ```

2. **Tenant Provider Management**
   ```typescript
   it('tenant can create custom BYOK provider', async () => {
     // Login as tenant owner
     // Navigate to providers page
     // Create custom provider
     // Verify appears in "Your Custom Providers"
   });
   ```

3. **Agent Provider Selection**
   ```typescript
   it('agent can select provider and model is validated', async () => {
     // Create agent
     // Select gateway provider
     // Select model from available list
     // Send chat request
     // Verify works
     // Try invalid model
     // Verify 400 error
   });
   ```

4. **Export/Import Portability**
   ```typescript
   it('agent export excludes provider config', async () => {
     // Create agent with specific provider
     // Export agent
     // Verify spec has no providerId or model
     // Verify spec has suggestedModels
     // Import to different tenant
     // Prompted for provider selection
     // Works with new provider
   });
   ```

### Performance Tests

1. **Cache Performance**
   - Measure cache hit rate
   - Verify eviction happens immediately
   - Test concurrent provider requests

2. **Query Performance**
   - Provider resolution query time
   - List providers query time
   - Test with 100+ providers

### Security Tests

1. **Gateway Provider Sanitization**
   - Tenant cannot see gateway provider API key
   - Tenant cannot see gateway provider endpoint details
   - Admin can see all details

2. **Tenant Provider Isolation**
   - Tenant A cannot access Tenant B's custom providers
   - Tenant A cannot update Tenant B's providers
   - Tenant A cannot delete Tenant B's providers

---

## Security Considerations

### API Key Encryption

All provider API keys are encrypted before storage:

```typescript
function encryptApiKey(apiKey: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `encrypted:${encrypted.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}`;
}
```

### Gateway Provider Sanitization

When listing providers for tenants, gateway providers are sanitized:

```typescript
function sanitizeGatewayProvider(provider: Provider) {
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    type: provider.type,
    isDefault: provider.isDefault,
    availableModels: provider.availableModels,
    // EXCLUDE: apiKey, baseUrl, deployment, apiVersion
  };
}
```

### Authorization

1. **Gateway Providers**
   - Only admins can create/update/delete
   - All tenants can view (sanitized)
   - All tenants can use

2. **Custom Providers**
   - Only tenant owner can create/update/delete
   - All tenant members can view
   - All tenant members can use

3. **Agent Provider Selection**
   - Tenant members can configure agents
   - Cannot select providers from other tenants
   - Can select any gateway provider

### Audit Logging

Log provider operations for security monitoring:

```typescript
fastify.log.info({
  action: 'provider_created',
  providerId: provider.id,
  providerName: provider.name,
  tenantId: provider.tenantId,
  userId: user.id,
  isGatewayProvider: provider.tenantId === null
}, 'Provider created');
```

---

## Migration Strategy

### Phase 1: Foundation (Story 1)
- Create Provider table
- Seed gateway default
- No breaking changes yet

### Phase 2: Parallel Operation (Stories 2-5)
- Provider entity exists alongside JSONB fields
- Both systems work simultaneously
- Gradual adoption

### Phase 3: Data Migration (Story 6)
- Migrate all JSONB configs to Provider records
- Backfill providerId/defaultProviderId
- Verify no data loss

### Phase 4: Cleanup (Story 6)
- Drop JSONB columns
- Provider entity is source of truth

### Rollback Plan

If issues discovered after migration:

1. **Before JSONB drop**: Re-populate JSONB from Provider records
2. **After JSONB drop**: Restore from backup, replay migrations
3. **Emergency**: Feature flag to revert to JSONB reading

---

## Appendix

### Database ER Diagram

```
┌─────────────────────┐
│     providers       │
│─────────────────────│
│ id (PK)             │
│ name                │
│ type                │
│ tenant_id (FK)      │──┐
│ is_default          │  │
│ api_key (encrypted) │  │
│ available_models[]  │  │
└─────────────────────┘  │
          ▲              │
          │              │
          │              │
┌─────────┴───────┐      │
│                 │      │
│                 │      │
┌─────────────────┴───┐  │     ┌──────────────────┐
│      agents         │  │     │     tenants      │
│─────────────────────│  │     │──────────────────│
│ id (PK)             │  │     │ id (PK)          │◀┘
│ provider_id (FK)    │──┘     │ default_prov...  │──┐
│ suggested_models[]  │        └──────────────────┘  │
└─────────────────────┘                              │
                                                     │
                                    ┌────────────────┘
                                    │
                            (resolves to Provider)
```

### API Key Encryption Flow

```
User Input: sk-abc123
     ↓
Generate random IV (16 bytes)
     ↓
AES-256-GCM encryption with IV
     ↓
Get auth tag for integrity
     ↓
Store: "encrypted:{ciphertext}:{iv}:{authTag}"
     ↓
Database: providers.api_key
```

### Provider Resolution Flow

```
Chat Request
     ↓
Load API Key → Agent
     ↓
agent.provider?
  YES → Use agent.provider
  NO  → tenant.defaultProvider?
          YES → Use tenant.defaultProvider
          NO  → Provider.findOne({tenantId: null, isDefault: true})
     ↓
Resolved Provider
     ↓
Validate model against provider.availableModels
     ↓
Create provider instance (cached by providerId)
     ↓
Forward request to LLM
```

---

**End of Architecture Document**

To convert to PDF:
```bash
# Using pandoc
pandoc docs/provider-architecture.md -o docs/provider-architecture.pdf --toc

# Or using markdown-pdf
markdown-pdf docs/provider-architecture.md
```
