# Verbal — History

## Core Context

**Project:** Loom — AI runtime control plane  
**Owner:** Michael Brown  
**Stack:** Node.js + TypeScript  
**Description:** Provider-agnostic OpenAI-compatible proxy with auditability, structured trace recording, streaming support, multi-tenant architecture, and observability dashboard.

**Domain methodology:** Peter Coad's Color Modeling (Java Modeling in Color with UML) — four archetypes: Moment-Interval (pink), Role (yellow), Catalog-Entry/Description (blue), Party/Place/Thing (green).

**Joined:** 2026-03-01

## Learnings

### 2026-03-01 — Registry/KB Domain Entities

Created domain entities for the artifact registry and knowledge base system, mapping to migration `1000000000015_registry.cjs`.

**Entity pattern:** Project uses plain TypeScript classes (not MikroORM decorators or EntitySchema). Classes contain fields with `!` definite assignment assertions, constructor logic that initializes with `randomUUID()`, and collection relationships as arrays.

**Entities created:**
- `Artifact` (🟢 Thing) — content-addressed bundle for KB/Agent/EmbeddingAgent
- `VectorSpace` (🔵 Catalog-Entry) — embedding configuration fingerprint
- `KbChunk` (🟢 Thing) — discrete document chunk with optional vector embedding
- `Deployment` (🩷 Moment-Interval) — artifact deployment lifecycle event
- `ArtifactTag` (🔵 Catalog-Entry) — mutable version pointer/label

**Agent entity updated:** Added `kind: 'inference' | 'embedding'` field with default 'inference'.

**pgvector handling:** The `embedding` field in `KbChunk` is typed as `number[] | null`. A JSDoc comment notes that raw SQL should be used for similarity search operations since MikroORM doesn't natively support pgvector.
