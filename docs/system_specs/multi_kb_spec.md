# Multi-Knowledge-Base Support per Agent

> Tracked by Epic [#TBD]

## Status

Draft -- MVP Specification

## Overview

Allow agents to reference multiple knowledge bases for RAG retrieval.
Currently agents have a single `knowledgeBaseRef` field (string). This
spec adds `knowledgeBaseRefs` (JSON array) alongside it for backward
compatibility. RAG injection queries all referenced KBs in parallel and
merges results by similarity score.

------------------------------------------------------------------------

## Design Goals

1. **Backward compatible:** existing singular `knowledgeBaseRef`
   continues to work without changes.
2. **Parallel retrieval:** query all KBs concurrently for minimal
   latency impact.
3. **Unified ranking:** merge chunks from all KBs by similarity score,
   then apply a global top-K limit.
4. **Source attribution:** each chunk in the RAG context identifies which
   KB it came from.
5. **Observable:** traces include a per-KB breakdown of retrieval
   metrics.

------------------------------------------------------------------------

## Spec Format

Both the new array format and the legacy singular format are supported:

```yaml
# New array format
spec:
  knowledgeBaseRefs:
    - company-policies-kb
    - product-docs-kb

# Legacy singular format (still works)
spec:
  knowledgeBaseRef: company-policies-kb

# Both can coexist (merged, deduplicated)
spec:
  knowledgeBaseRef: company-policies-kb
  knowledgeBaseRefs:
    - product-docs-kb
    - internal-docs-kb
```

When both fields are present, the resolved list is the union of
`knowledgeBaseRef` and `knowledgeBaseRefs`, deduplicated in declaration
order.

------------------------------------------------------------------------

## Schema Changes

### Agent Entity

Add a `knowledgeBaseRefs` field (JSON array, nullable). Keep
`knowledgeBaseRef` (string, nullable) for backward compatibility.

The entity exposes an accessor that merges both fields into a single
deduplicated list:

```typescript
get resolvedKnowledgeBaseRefs(): string[] {
  const refs: string[] = [];
  if (this.knowledgeBaseRef) refs.push(this.knowledgeBaseRef);
  if (this.knowledgeBaseRefs) refs.push(...this.knowledgeBaseRefs);
  return [...new Set(refs)];
}
```

### EntitySchema Addition

```typescript
knowledgeBaseRefs: {
  type: 'json',
  nullable: true,
  default: null,
  columnType: 'jsonb',
}
```

### Migration

```sql
ALTER TABLE agents ADD COLUMN knowledge_base_refs JSONB DEFAULT NULL;
```

The down migration drops the column:

```sql
ALTER TABLE agents DROP COLUMN knowledge_base_refs;
```

### TenantContext

Add `knowledgeBaseRefs?: string[]` alongside the existing
`knowledgeBaseRef`. The auth layer populates both from the resolved
agent configuration.

------------------------------------------------------------------------

## RAG Injection Changes

Modify `injectRagContext()` in `src/agent.ts` to support multiple KBs:

1. Call `resolvedKnowledgeBaseRefs` to get the deduplicated list.
2. Resolve all KB artifacts by name (parallel `em.findOne` calls via
   `Promise.all`).
3. Call `retrieveChunks()` for each resolved artifact (parallelize with
   `Promise.all`). Each call uses the KB's configured embedder.
4. Merge all returned chunks into a single array.
5. Re-sort by similarity score descending.
6. Apply the global top-K limit (configurable per agent, default 5).
7. Build unified RAG context with source attribution.

If any KB reference fails to resolve, emit a warning in the trace and
continue with the remaining KBs (partial degradation rather than total
failure).

### Source Attribution

Each chunk in the injected context is prefixed with its KB name so the
LLM can distinguish sources:

```
[From: company-policies-kb] Chunk content here...
[From: product-docs-kb] Another chunk here...
```

### Performance Considerations

- N KBs produce N artifact lookups and N embedding calls (if the KBs use
  different embedders). All lookups and retrievals run in parallel.
- Embedding generation already happens before the provider proxy call,
  so it does not add gateway latency to the response path.
- Future optimization: cache the query embedding and reuse it across KBs
  that share the same embedder and model.
- A per-agent `ragTopK` override limits total injected chunks regardless
  of KB count.

------------------------------------------------------------------------

## Trace Fields

Existing scalar trace fields (`ragLatencyMs`, `ragChunkCount`,
`ragTopSimilarity`) remain for backward compatibility. A new
`ragDetails` JSON field provides the per-KB breakdown:

```typescript
ragDetails: {
  knowledgeBases: Array<{
    knowledgeBaseId: string;
    name: string;
    retrievalLatencyMs: number;
    chunkCount: number;
    topSimilarity: number;
    avgSimilarity: number;
  }>;
  totalChunksRetrieved: number;
  totalChunksInjected: number;  // after global top-K
  mergeLatencyMs: number;
}
```

The existing scalar fields are populated from the aggregate values
(total latency, total chunk count, best similarity across all KBs) so
that dashboards and analytics queries continue to work without changes.

------------------------------------------------------------------------

## CLI Validation

`arachne weave` validates all refs in the `knowledgeBaseRefs` array
using the same resolution strategy as the singular ref:

1. Check the local workspace first (for co-located KB specs).
2. Fall back to the registry.
3. Report an error if any ref cannot be resolved.

Error messages follow the existing cross-reference error format:

```
Error: unresolved reference "missing-kb" in spec.knowledgeBaseRefs[1]
  (Agent "my-agent" references KnowledgeBase "missing-kb" which was not
   found in the workspace or registry)
```

------------------------------------------------------------------------

## Workspace Integration

The workspace cross-reference table gains a new row:

| Field | Source Kind | Target Kind |
|-------|------------|-------------|
| `spec.knowledgeBaseRef` | Agent | KnowledgeBase |
| `spec.knowledgeBaseRefs[]` | Agent | KnowledgeBase |

Multiple KBs are resolved in the same dependency-ordering pass as the
singular `knowledgeBaseRef`. This ensures that all referenced KBs are
woven before the agent that depends on them.

------------------------------------------------------------------------

## Portal and Dashboard Integration

### Portal

The agent editor gains a multi-select field for knowledge base
references. The existing single-select field is replaced by a
multi-select that writes to `knowledgeBaseRefs`. If only one KB is
selected, the backend may store it in either field (both resolve
identically).

### Dashboard

The trace detail view displays the `ragDetails` breakdown when present:
per-KB retrieval latency, chunk counts, and similarity scores. The
existing summary view continues to show aggregate values.

------------------------------------------------------------------------

## API Changes

### Agent CRUD Endpoints

All agent creation and update endpoints (portal and admin) accept the
new `knowledgeBaseRefs` field:

```json
{
  "name": "my-agent",
  "knowledgeBaseRef": "legacy-kb",
  "knowledgeBaseRefs": ["kb-one", "kb-two"]
}
```

Response payloads include both fields plus a computed
`resolvedKnowledgeBaseRefs` array for convenience.

### Validation Rules

- Each entry in `knowledgeBaseRefs` must be a non-empty string.
- Duplicate entries (including overlap with `knowledgeBaseRef`) are
  silently deduplicated.
- Maximum of 10 knowledge base references per agent (configurable).

------------------------------------------------------------------------

## Future Extensions

- **Per-KB weighting:** prioritize chunks from one KB over another via a
  numeric weight.
- **KB-specific top-K limits:** allow different chunk counts per KB
  before the global merge.
- **Conditional KB inclusion:** select KBs dynamically based on query
  classification (e.g., route technical questions to the API docs KB
  only).
- **KB groups / collections:** named groupings of KBs that can be
  referenced as a single unit.
