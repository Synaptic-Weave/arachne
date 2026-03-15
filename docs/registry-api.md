# Registry API

The Arachne Registry is a centralized artifact storage system for publishing and deploying knowledge bases, agents, and embedder configurations. Artifacts are versioned, scoped to your organization, and deployed as immutable bundles.

## Overview

The registry stores three types of artifacts:

1. **KnowledgeBase** — Vectorized document collections (chunked, embedded, deployed for RAG retrieval)
2. **Agent** — Agent YAML specs with system prompts and tool definitions
3. **EmbeddingAgent** — Embedding provider configurations for RAG chunking and retrieval

All artifacts are:
- **Versioned** with semantic tags (e.g., `latest`, `v1.0.0`)
- **Signed with HMAC-SHA256** — bundles are cryptographically signed and verified at deployment
- **Scoped to your org** — accessed via `org_slug/artifact_name:tag` references
- **Tenant-isolated** — each organization's artifacts are stored and accessed separately

## Authentication

All Registry API endpoints require a JWT token scoped with Registry capabilities. The token is minted via the portal or programmatically.

**JWT Scopes:**
- `registry:push` — Publish and delete artifacts
- `artifact:read` — List and pull artifacts
- `deploy:write` — Deploy artifacts to environments

Scopes are embedded in the JWT token claims under the `scopes` field. The token is passed as:

```bash
curl -H "Authorization: Bearer <REGISTRY_JWT>" https://api.arachne-ai.com/v1/registry/...
```

## Artifact Naming Convention

Artifacts are addressed using the pattern:

```
{org_slug}/{artifact_name}:{tag}
```

**Rules:**

- **org_slug** — URL-safe, lowercase alphanumeric + hyphens (e.g., `acme-corp`, `my-org`)
- **artifact_name** — Project or component name (e.g., `knowledge-base`, `my-agent`)
- **tag** — Semantic version or label (e.g., `latest`, `v1.0`, `production`). Defaults to `latest`.

**Examples:**

```
acme-corp/product-docs:v1.0
my-org/rag-kb:latest
engineering/code-assist:staging
```

## Bundle Format

Artifacts are published as `.orb` (tar + gzip) bundles with the following structure:

### KnowledgeBase Bundle

```
kb-name.orb/
├── manifest.json           # Metadata (kind, name, version, chunkCount, vectorSpace)
└── chunks/
    ├── 0.json             # { content, sourcePath, tokenCount, embedding }
    ├── 1.json
    └── ...
```

**manifest.json** format:

```json
{
  "kind": "KnowledgeBase",
  "name": "my-kb",
  "version": "2024-01-15T10:30:45.123Z",
  "chunkCount": 42,
  "vectorSpace": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

### Agent / EmbeddingAgent Bundle

```
agent-name.orb/
├── manifest.json           # { kind, name, version }
└── spec.json              # Full YAML spec as JSON
```

### Bundle Signing

Bundles are signed with HMAC-SHA256 using the `BUNDLE_SIGNING_SECRET` environment variable. The signature is computed over the gzipped tar data and returned with each push. Signatures are optional but recommended for production deployments.

## API Endpoints

### Push / Publish Artifact

**POST** `/v1/registry/push`

Publish a new artifact version or overwrite an existing tag.

**Authentication:** Requires `registry:push` scope

**Request (multipart/form-data):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bundle` | file | ✓ | Gzipped tar bundle (.orb) |
| `name` | string | ✓ | Artifact name (e.g., `my-kb`) |
| `tag` | string | | Version tag (defaults to `latest`) |
| `kind` | string | ✓ | One of `KnowledgeBase`, `Agent`, `EmbeddingAgent` |
| `sha256` | string | | Pre-computed SHA-256 of bundle (for verification) |
| `chunkCount` | number | | Number of chunks (for KnowledgeBase artifacts) |

**Response (201 Created):**

```json
{
  "artifactId": "550e8400-e29b-41d4-a716-446655440000",
  "ref": "acme-corp/my-kb:latest"
}
```

**Example:**

```bash
curl -X POST https://api.arachne-ai.com/v1/registry/push \
  -H "Authorization: Bearer $REGISTRY_JWT" \
  -F "bundle=@my-kb.orb" \
  -F "name=my-kb" \
  -F "tag=v1.0" \
  -F "kind=KnowledgeBase" \
  -F "chunkCount=42"
```

### List Artifacts

**GET** `/v1/registry/list?org={org_slug}`

List all artifacts for your organization.

**Authentication:** Requires `artifact:read` scope

**Response (200 OK):**

```json
[
  {
    "name": "my-kb",
    "tags": ["latest", "v1.0", "v0.9"],
    "kind": "KnowledgeBase",
    "latestVersion": "2024-01-15T10:30:45.123Z"
  },
  {
    "name": "my-agent",
    "tags": ["latest"],
    "kind": "Agent",
    "latestVersion": "2024-01-14T08:15:00.000Z"
  }
]
```

### Pull Artifact

**GET** `/v1/registry/pull/{org}/{name}/{tag}`

Download a specific artifact bundle.

**Authentication:** Requires `artifact:read` scope

**Response (200 OK):**

- Content-Type: `application/octet-stream`
- Body: Raw `.orb` bundle data

**Example:**

```bash
curl -H "Authorization: Bearer $REGISTRY_JWT" \
  https://api.arachne-ai.com/v1/registry/pull/acme-corp/my-kb/v1.0 \
  -o my-kb.orb
```

### Delete Artifact

**DELETE** `/v1/registry/{org}/{name}/{tag}`

Remove a specific artifact version. If no other tags point to this artifact, the entire version is deleted.

**Authentication:** Requires `registry:push` scope

**Response (200 OK):**

```json
{
  "deleted": true
}
```

**Example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $REGISTRY_JWT" \
  https://api.arachne-ai.com/v1/registry/acme-corp/my-kb/v0.9
```

## Deployments

Once an artifact is published, it can be deployed to a runtime environment. Deployments are immutable snapshots of an artifact version that generate a scoped JWT token for runtime access.

### Deploy Artifact

**POST** `/v1/registry/deployments/{org}/{name}/{tag}?environment={env}`

Deploy an artifact to a runtime environment.

**Authentication:** Requires `deploy:write` scope

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `org` | string | ✓ | Organization slug |
| `name` | string | ✓ | Artifact name |
| `tag` | string | ✓ | Version tag (use `latest` for most recent) |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `environment` | string | | Environment label (defaults to `production`). Note: In v1, this is metadata only - no infrastructure isolation. |

**Example:**

```bash
curl -X POST \
  -H "Authorization: Bearer $REGISTRY_JWT" \
  'https://api.arachne-ai.com/v1/registry/deployments/acme-corp/my-kb/v1.0?environment=production'
```

**Response (201 Created or 200 OK):**

```json
{
  "deploymentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "READY",
  "runtimeToken": "eyJhbGc..."
}
```

The `runtimeToken` is a scoped JWT that:
- Expires in 1 year
- Grants `runtime:access` permission
- Contains the artifact ID and deployment ID
- Can be used by inference clients to access the deployed artifact

**Failure Response (200 OK with status: FAILED):**

```json
{
  "deploymentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "FAILED",
  "errorMessage": "Knowledge base has no chunks loaded"
}
```

### List Deployments

**GET** `/v1/registry/deployments`

List all active deployments for your tenant.

**Authentication:** Requires `artifact:read` scope

**Response (200 OK):**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "artifact": {
      "id": "660f9511-f40c-52e5-b827-557766551111",
      "org": "acme-corp",
      "name": "my-kb",
      "kind": "KnowledgeBase",
      "version": "2024-01-15T10:30:45.123Z"
    },
    "environment": "production",
    "status": "READY",
    "deployedAt": "2024-01-16T09:00:00.000Z"
  }
]
```

### Undeploy (Delete Deployment)

**DELETE** `/v1/registry/deployments/{deploymentId}`

Stop a deployment and revoke its runtime token.

**Authentication:** Requires `deploy:write` scope

**Response (200 OK):**

```json
{
  "success": true
}
```

## Usage in the Arachne CLI

The Registry API is used internally by the `arachne` CLI. Developers use CLI commands to weave, push, and deploy artifacts:

```bash
# Weave a knowledge base from a YAML spec + docs directory
arachne weave knowledge-base.yaml

# Push to registry
arachne push my-kb.orb \
  --name my-kb \
  --org acme-corp \
  --tag v1.0

# Deploy to production (tag defaults to "latest" if omitted)
arachne deploy acme-corp/my-kb:v1.0 --environment production

# Deploy latest version to staging
arachne deploy acme-corp/my-kb --environment staging
```

See [docs/cli.md](cli.md) for full CLI reference.

## Errors

Common error responses:

| Status | Error | Meaning |
|--------|-------|---------|
| 400 | `Missing bundle file` | No `.orb` file provided |
| 400 | `Missing name field` | Artifact name not specified |
| 400 | `Missing kind field` | Kind (KnowledgeBase, Agent, etc.) not specified |
| 400 | `sha256 mismatch` | Pre-computed SHA-256 doesn't match bundle data |
| 400 | `Invalid artifact reference` | Deploy request has invalid org/name/tag in path |
| 401 | `Unauthorized` | Invalid or expired JWT token |
| 403 | `Forbidden` | JWT does not have required scope for operation |
| 404 | `Artifact not found` | Requested artifact/deployment does not exist |
| 500 | `Internal Server Error` | Server error; contact support |
