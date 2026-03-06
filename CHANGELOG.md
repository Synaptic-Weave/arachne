# Changelog

All notable changes to Arachne will be documented in this file.

## [Unreleased]

### Added
- **Provider Entity Foundation**: Created Provider entity system for managing gateway and tenant-specific LLM providers
  - New `providers` table with support for gateway-wide and tenant-scoped providers
  - Gateway default provider seeded from environment variables
  - Provider entity with type safety replacing untyped JSONB configs
  - Comprehensive architecture documentation in `docs/provider-architecture.md`
  - GitHub Epic #101 and User Stories #102-108 created for multi-provider system

### Fixed
- **Provider Cache Bug**: Fixed provider cache not being invalidated when agent configuration changes
  - Added `evictProvider(agentId)` call in `TenantManagementService.updateAgent()`
  - Provider configuration updates now take effect immediately without server restart

### Documentation
- Added comprehensive provider architecture documentation (`docs/provider-architecture.md`)
- Created GitHub Epic #101: Multi-Provider Management System
- Created 7 user stories for vertical slice implementation (#102-108)

---

## Previous Releases

[Previous changelog entries would go here]
