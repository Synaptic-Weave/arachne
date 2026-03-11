# Changelog

All notable changes to Arachne will be documented in this file.

## [Unreleased]

### Changed
- **Provider Entity Refactor**: Converted Provider to use Single Table Inheritance (STI)
  - Refactored `Provider` entity into `ProviderBase` abstract class
  - Created `OpenAIProvider`, `AzureProvider`, `OllamaProvider` concrete classes
  - MikroORM discriminator column on `type` field for polymorphic queries
  - Type-specific validation in each provider class (`validate()` method)
  - Polymorphic `createClient()` and `sanitizeForTenant()` methods
  - Type-safe provider-specific fields (Azure deployment/apiVersion, Ollama baseUrl)

### Added
- **Provider Entity Foundation**: Created Provider entity system for managing gateway and tenant-specific LLM providers
  - New `providers` table with support for gateway-wide and tenant-scoped providers
  - Gateway default provider seeded from environment variables
  - Provider entity with type safety replacing untyped JSONB configs
  - Comprehensive architecture documentation in `docs/provider-architecture.md`)
  - GitHub Epic #101 and User Stories #102-108 created for multi-provider system

- **Gateway Provider Management** (Story 2): Admin API for managing gateway providers
  - `ProviderManagementService` with full CRUD operations for gateway providers
  - Admin API routes: `GET/POST/PUT/DELETE /v1/admin/providers`
  - `POST /v1/admin/providers/:id/default` - Set default provider (unsets others)
  - Provider DTOs: `ProviderViewModel`, `CreateProviderDto`, `UpdateProviderDto`
  - Type-specific validation on create/update (Azure requires deployment/apiVersion)
  - Provider view model includes type-specific fields based on discriminator

### Fixed
- **Provider Cache Bug**: Fixed provider cache not being invalidated when agent configuration changes
  - Added `evictProvider(agentId)` call in `TenantManagementService.updateAgent()`
  - Provider configuration updates now take effect immediately without server restart

### Documentation
- Added comprehensive provider architecture documentation (`docs/provider-architecture.md`)
- Added detailed STI refactor + Story 2 implementation plan (`docs/sti-refactor-plan.md`)
- Created GitHub Epic #101: Multi-Provider Management System
- Created 7 user stories for vertical slice implementation (#102-108)

---

## Previous Releases

[Previous changelog entries would go here]
