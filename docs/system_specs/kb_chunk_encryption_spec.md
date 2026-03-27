# KB Chunk Content Encryption at Rest

> Tracked by Issue [#TBD]

## Status

Draft

## Overview

Knowledge base chunk content is currently stored in plaintext in the `kb_chunks` table. This is an encryption gap: trace request/response bodies, conversation messages, conversation snapshots, and provider API keys are all encrypted at rest using per-tenant AES-256-GCM encryption (derived via `HMAC-SHA256(ENCRYPTION_MASTER_KEY, tenantId)`). If an attacker gains database access without the keyvault-protected master key, they can read KB chunk content but not any other sensitive tenant data.

This spec closes that gap by encrypting the `content` column using the same per-tenant key derivation and AES-256-GCM algorithm already used throughout the codebase. A new `content_iv` column stores the initialization vector alongside the ciphertext. Vector embeddings remain unencrypted (they are numerical arrays needed for similarity search and do not contain human-readable sensitive content).

The implementation follows the exact pattern established by `ConversationMessage` (which stores `contentEncrypted` + `contentIv`) and `Trace` (which stores `requestBody` + `requestIv`, `responseBody` + `responseIv`). A backfill migration encrypts all existing plaintext chunks in place.

------------------------------------------------------------------------

## Design Goals

1. **Parity with existing encryption:** KB chunks get the same AES-256-GCM per-tenant encryption already applied to traces, conversations, and provider keys.
2. **Zero retrieval regression:** Vector similarity search (pgvector cosine distance on the `embedding` column) is unaffected. Decryption happens after retrieval, not during SQL execution.
3. **Backward-compatible migration:** Existing plaintext chunks are encrypted in place via a backfill migration. The migration is idempotent (safe to re-run).
4. **Minimal code surface:** Reuse `encryptTraceBody` / `decryptTraceBody` from `src/encryption.ts` (no new crypto code needed).
5. **Observable:** Failed decryptions are logged and skipped (graceful degradation), matching the pattern in `ConversationManagementService`.

------------------------------------------------------------------------

## What Gets Encrypted (and What Does Not)

| Column | Encrypted? | Reason |
|--------|-----------|--------|
| `content` | Yes | Human-readable text, potentially sensitive (internal docs, policies, PII) |
| `content_iv` | N/A (new column) | Stores the 12-byte IV as 24-char hex string |
| `embedding` | No | Numerical vector; not human-readable; required for pgvector similarity search |
| `source_path` | No | File path metadata (not content); low sensitivity |
| `metadata` | No | Structural metadata (not content); low sensitivity |
| `token_count` | No | Integer; not sensitive |
| `chunk_index` | No | Integer; not sensitive |

------------------------------------------------------------------------

## Schema Changes

Add a `content_iv` column to `kb_chunks`:

```sql
ALTER TABLE kb_chunks
  ADD COLUMN content_iv varchar(24);
```

After the backfill migration completes, apply a NOT NULL constraint:

```sql
ALTER TABLE kb_chunks
  ALTER COLUMN content_iv SET NOT NULL;
```

The `content` column retains the `text` type (ciphertext is hex-encoded and fits in `text`). No column rename is needed: the column name stays `content` but now holds ciphertext. This matches the `Trace` pattern where `request_body` holds ciphertext alongside `request_iv`.

Note: The column is initially nullable so the migration can add it, backfill values, then apply the constraint. This avoids a full table lock on large datasets.

------------------------------------------------------------------------

## Encryption Flow (on push/write)

When `RegistryService.push()` persists KB chunks, each chunk's `content` is encrypted before storage.

### Pseudocode

```typescript
// In RegistryService.push(), where chunks are created:
import { encryptTraceBody } from '../encryption.js';

// tenantId is available from input.tenantId
for (const [idx, c] of input.chunks.entries()) {
  const { ciphertext, iv } = encryptTraceBody(input.tenantId, c.content);
  const chunk = new KbChunk(artifact, idx, ciphertext, {
    sourcePath: c.sourcePath,
    tokenCount: c.tokenCount,
    embedding: c.embedding,
    metadata: c.metadata,
    contentIv: iv,          // new field
  });
  em.persist(chunk);
}
```

The `tenantId` is already available as `input.tenantId` in every `RegistryService.push()` call path (passed from `registryUser.tenantId` in the route handler).

------------------------------------------------------------------------

## Decryption Flow (on RAG retrieval read)

When `retrieveChunks()` in `src/rag/retrieval.ts` returns results from pgvector similarity search, the raw SQL already returns `content` (now ciphertext). Decryption happens immediately after the query, before building the `RetrievedChunk` array.

### Pseudocode

```typescript
// In retrieveChunks(), after the raw SQL query:
import { decryptTraceBody } from '../encryption.js';

// Update SQL to also SELECT content_iv
const sql = `
  SELECT id, content, content_iv, source_path,
         1 - (embedding <=> ?::vector) AS similarity_score
  FROM kb_chunks
  WHERE artifact_id = ?
  ORDER BY embedding <=> ?::vector
  LIMIT ?
`;

// Decrypt each row
const chunks: RetrievedChunk[] = [];
for (const [index, row] of rows.entries()) {
  try {
    const plaintext = decryptTraceBody(tenantId, row.content, row.content_iv);
    chunks.push({
      id: row.id,
      content: plaintext,
      sourcePath: row.source_path ?? undefined,
      similarityScore: parseFloat(row.similarity_score),
      rank: index + 1,
    });
  } catch (err) {
    console.error(`[rag:retrieval] failed to decrypt chunk ${row.id}:`, err);
    // Skip chunks that fail decryption (key rotation edge case)
  }
}
```

The `tenantId` parameter is already passed into `retrieveChunks()` and currently unused for encryption. No signature change needed.

------------------------------------------------------------------------

## Migration Plan

### Migration: `1000000000035_encrypt-kb-chunk-content.cjs`

The migration has three phases:

**Phase 1: Add column (DDL)**

```javascript
exports.up = async (pgm) => {
  pgm.addColumns('kb_chunks', {
    content_iv: { type: 'varchar(24)', notNull: false },
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('kb_chunks', ['content_iv']);
};
```

**Phase 2: Backfill (separate script)**

A Node.js backfill script processes chunks in batches:

```typescript
// scripts/backfill-kb-chunk-encryption.ts
// Run with: npx tsx scripts/backfill-kb-chunk-encryption.ts

const BATCH_SIZE = 500;

// Query: SELECT kc.id, kc.content, a.tenant_id
//        FROM kb_chunks kc
//        JOIN artifacts a ON kc.artifact_id = a.id
//        WHERE kc.content_iv IS NULL
//        LIMIT $BATCH_SIZE

// For each row:
//   const { ciphertext, iv } = encryptTraceBody(tenantId, content);
//   UPDATE kb_chunks SET content = $ciphertext, content_iv = $iv WHERE id = $id
```

Key design decisions for the backfill:

- **Batch size of 500:** Avoids locking the table for too long per transaction.
- **Tenant resolution via JOIN:** `kb_chunks.artifact_id` joins to `artifacts.tenant_id` to get the encryption key.
- **Idempotent:** The `WHERE content_iv IS NULL` clause means the script can be re-run safely if interrupted.
- **Progress logging:** Log every batch (e.g., "Encrypted 500 chunks, 3,200 remaining").

**Phase 3: Apply NOT NULL constraint (follow-up migration)**

After confirming the backfill is complete (`SELECT COUNT(*) FROM kb_chunks WHERE content_iv IS NULL` returns 0):

```javascript
// Migration: 1000000000036_kb-chunk-content-iv-not-null.cjs
exports.up = async (pgm) => {
  pgm.alterColumn('kb_chunks', 'content_iv', { notNull: true });
};

exports.down = async (pgm) => {
  pgm.alterColumn('kb_chunks', 'content_iv', { notNull: false });
};
```

### Rollback Strategy

The `down` migration drops the `content_iv` column but does NOT decrypt content back to plaintext (that would require the master key at migration time, which is unsafe). Instead, rolling back requires running a reverse backfill script that decrypts content and sets `content_iv` to NULL, then running `migrate:down`.

------------------------------------------------------------------------

## Code Changes

### 1. `src/domain/entities/KbChunk.ts`

Add `contentIv` field:

```typescript
export class KbChunk {
  // ... existing fields ...
  contentIv!: string | null;

  constructor(
    artifact: Artifact,
    chunkIndex: number,
    content: string,      // now receives ciphertext
    options?: {
      sourcePath?: string;
      tokenCount?: number;
      embedding?: number[];
      metadata?: Record<string, unknown>;
      contentIv?: string;   // new option
    },
  ) {
    // ... existing assignments ...
    this.contentIv = options?.contentIv ?? null;
  }
}
```

### 2. `src/domain/schemas/KbChunk.schema.ts`

Add `contentIv` property to the schema:

```typescript
contentIv: {
  type: 'string',
  columnType: 'varchar(24)',
  fieldName: 'content_iv',
  nullable: true,  // nullable until backfill completes
},
```

### 3. `src/services/RegistryService.ts`

Import `encryptTraceBody` and encrypt content before persisting chunks. Changes needed in the push flow where `new KbChunk(...)` is called.

### 4. `src/rag/retrieval.ts`

Import `decryptTraceBody` and decrypt content after retrieval:
- Add `content_iv` to the SELECT clause in the raw SQL query
- Decrypt each row's `content` using `decryptTraceBody(tenantId, row.content, row.content_iv)`
- Wrap decryption in try/catch (skip failures, matching `ConversationManagementService` pattern)

### 5. `src/encryption.ts`

No changes needed. The existing `encryptTraceBody` and `decryptTraceBody` functions are generic (despite the "Trace" name) and work for any tenant-scoped string data.

------------------------------------------------------------------------

## Performance Considerations

**Encryption overhead on push:** AES-256-GCM encryption of a text chunk is sub-millisecond. For a 1,000-chunk KB push, total encryption overhead is under 50ms (negligible compared to embedding generation, which takes seconds).

**Decryption overhead on retrieval:** RAG retrieval returns at most `topK` chunks (default 5). Decrypting 5 chunks adds under 1ms total.

**Ciphertext size expansion:** AES-256-GCM with hex encoding roughly doubles the stored size plus a 32-char auth tag. For typical KB chunks (500-2000 tokens, roughly 2-8KB of text), storage increases from ~5KB average to ~11KB average per chunk. For a 10,000-chunk KB, this adds approximately 60MB of additional storage (acceptable for PostgreSQL).

**Backfill performance:** At 500 chunks per batch with ~1ms encrypt per chunk, each batch takes under 1 second. A 100,000-chunk database backfills in approximately 3-4 minutes. The backfill can run while the gateway is live (no downtime required).

**Transitional compatibility:** During the window between deploying the new code and completing the backfill, `retrieval.ts` must handle both encrypted (has `content_iv`) and plaintext (NULL `content_iv`) chunks:

```typescript
if (row.content_iv) {
  content = decryptTraceBody(tenantId, row.content, row.content_iv);
} else {
  content = row.content; // legacy plaintext, not yet backfilled
}
```

This guard can be removed after the backfill completes and the NOT NULL migration runs.

------------------------------------------------------------------------

## Testing Plan

### Unit Tests

1. **Encryption round-trip for KB chunks:** Encrypt content, verify ciphertext differs from plaintext, decrypt, verify match.
2. **RegistryService stores encrypted content:** Verify `push()` persists KbChunk instances with encrypted content and contentIv.
3. **Retrieval decrypts content:** Mock raw SQL to return encrypted rows, verify `retrieveChunks()` returns plaintext.
4. **Graceful degradation on decryption failure:** Mock corrupted content_iv, verify chunk is skipped (not thrown).
5. **Transitional compatibility:** Mock mixed result set (some encrypted, some plaintext), verify both returned correctly.

### Integration Tests

6. **Full push-and-retrieve round-trip:** Push a KB artifact with chunks, then retrieve via vector search, verify returned content matches original plaintext.

### Migration Tests

7. **Backfill idempotency:** Run backfill twice, verify no errors on second run.
8. **NOT NULL constraint enforcement:** After backfill, verify INSERT without content_iv fails.

------------------------------------------------------------------------

## Deployment Sequence

1. Merge the `content_iv` column migration (035). Run `npm run migrate:up`.
2. Deploy the updated application code (RegistryService encrypts on write, retrieval.ts decrypts on read, with the transitional NULL guard).
3. Run the backfill script: `npx tsx scripts/backfill-kb-chunk-encryption.ts`.
4. Verify: `SELECT COUNT(*) FROM kb_chunks WHERE content_iv IS NULL` returns 0.
5. Merge and run the NOT NULL migration (036).
6. Remove the transitional NULL guard from `retrieval.ts` (optional cleanup, can be a follow-up PR).
