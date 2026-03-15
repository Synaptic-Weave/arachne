# Arachne CLI Reference

The `loom` CLI client connects to an Arachne AI Runtime (self-hosted or remote) to define, package, and deploy AI Agent and KnowledgeBase artifacts.

## Installation

```bash
npm install -g @arachne/cli
```

Verify the installation:

```bash
arachne --version
```

## Quick Start: End-to-End Example

This walkthrough creates a support agent backed by a KnowledgeBase of documentation files, packages them as versioned artifacts, and deploys them to a tenant.

### Step 1: Authenticate

```bash
arachne login https://your-arachne-runtime.com
# Prompts for email and password
# ✓ Logged in as alice@acme.com (tenant: acme)
```

Your credentials are stored in `~/.arachne/config.json`.

### Step 2: Define a KnowledgeBase

Create `support-kb.yaml`:

```yaml
apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: support-kb
spec:
  docsPath: ./docs        # directory, single file, or .zip
  embedder:               # optional — defaults to system-embedder EmbeddingAgent
    agentRef: my-embedder # name of an EmbeddingAgent in your tenant's agent registry
  chunking:
    tokenSize: 650
    overlap: 120
  retrieval:
    topK: 8
    citations: true
```

### Step 3: Define an Agent

Create `support-agent.yaml`:

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: support-agent
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    You are SupportAgent. Use the knowledge base to answer questions.
    If the answer isn't in the knowledge base, say you don't know.
  knowledgeBaseRef: support-kb
```

### Step 4: Weave both specs into bundles

```bash
arachne weave support-kb.yaml
# Uploading spec and docs to gateway...
# Chunking 47 documents (3,821 chunks)...
# Generating embeddings...
# ✓ Bundle saved to dist/support-kb.orb
#   sha256: a3f8c2d1...
#   VectorSpace: vs_openai_text-embedding-3-small_1536

arachne weave support-agent.yaml
# ✓ Bundle saved to dist/support-agent.orb
#   sha256: b7e4a9f2...
```

### Step 5: Push bundles to the registry

```bash
arachne push dist/support-kb.orb --tag 0.1.0
# ✓ acme/support-kb:0.1.0

arachne push dist/support-agent.orb --tag 0.1.0
# ✓ acme/support-agent:0.1.0
```

### Step 6: Deploy the agent to a tenant

```bash
arachne deploy acme/support-agent:0.1.0 --tenant acme --env prod
# Resolving artifact...
# Validating VectorSpace...
# Provisioning KB collection...
# ✓ Deployment READY
#   Runtime token: loom_rt_...
```

The agent is now available for inference via any API key scoped to the `support-agent` agent on the `acme` tenant.

---

## Commands

### `arachne login [gateway-url]`

Authenticate against an Arachne AI Runtime and store credentials locally.

```bash
arachne login https://your-arachne-runtime.com
arachne login                                  # prompts for gateway URL
```

**Options:**

| Flag | Description |
|------|-------------|
| `--email <email>` | Email address (prompted if omitted) |
| `--password <password>` | Password (prompted securely if omitted) |

**Config file:** `~/.arachne/config.json`

```json
{
  "gatewayUrl": "https://your-arachne-runtime.com",
  "token": "eyJ...",
  "email": "alice@acme.com"
}
```

---

### `arachne weave <spec-file>`

Upload a YAML spec (and its documents) to the AI Runtime. The AI Runtime chunks the documents, generates embeddings, and returns a signed bundle.

```bash
arachne weave support-kb.yaml
arachne weave support-agent.yaml
arachne weave ./specs/support-kb.yaml --out ./artifacts/
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--out <dir>` | `dist/` | Output directory for the bundle |
| `--gateway <url>` | from config | Override the gateway URL |

**How it works:**

1. Reads the YAML spec file
2. Resolves `spec.docsPath` relative to the spec file:
   - **Directory** → all files recursively
   - **Single file** → just that file
   - **.zip file** → extracted in-memory; all contained files processed
3. Uploads spec + docs to `POST /v1/registry/weave`
4. AI Runtime chunks docs, embeds, packages, signs
5. Returns bundle → saved to `dist/<name>.orb`

**Output:**
```
dist/
  support-kb.orb
  support-agent.orb
```

---

### `arachne push <bundle-file>`

Push a bundle file to the AI Runtime registry and tag it.

```bash
arachne push dist/support-kb.orb --tag 0.1.0
arachne push dist/support-agent.orb --tag 0.1.0
arachne push dist/support-agent.orb              # defaults to tag: latest
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tag <tag>` | `latest` | Version tag for the artifact |
| `--gateway <url>` | from config | Override the gateway URL |

**Output:**
```
✓ acme/support-kb:0.1.0
✓ acme/support-agent:0.1.0
```

The org prefix is your tenant's **org slug** — configurable in portal Settings, defaults to a slugified version of your tenant name.

**Immutability:** Pushing a bundle with the same SHA-256 as an existing artifact is a no-op — the existing artifact is reused and the tag is updated.

---

### `arachne deploy <artifact:tag>`

Deploy an artifact from the registry to a tenant environment.

```bash
arachne deploy acme/support-agent:0.1.0 --tenant acme --env prod
arachne deploy acme/support-agent:0.1.0 --tenant staging-tenant --env staging
```

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--tenant <name>` | yes | Target tenant slug |
| `--env <env>` | no (default: `prod`) | Deployment environment |
| `--gateway <url>` | no | Override the gateway URL |

**What happens:**

1. Resolves the artifact from the registry
2. Validates your permissions on the target tenant
3. Verifies VectorSpace contract — refuses if the KB embedder has changed
4. Provisions a pgvector index for the KB chunks (scoped to this tenant)
5. Attaches the agent's model config to the tenant
6. Mints a scoped runtime JWT (limited to inference + KB read)
7. Records the deployment as READY

**Output:**
```
Resolving artifact acme/support-agent:0.1.0...
Validating VectorSpace: vs_openai_text-embedding-3-small_1536 ✓
Provisioning KB collection for support-kb...
✓ Deployment READY
  Runtime token: loom_rt_eyJ...
  Environment: prod
  Deployed at: 2025-03-01T12:00:00Z
```

---

## YAML Spec Reference

### KnowledgeBase

```yaml
apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: <string>              # artifact name, used as knowledgeBaseRef in Agent specs
spec:
  docsPath: <path>            # REQUIRED: directory | single file | .zip file
  embedder:                   # OPTIONAL — defaults to system-embedder EmbeddingAgent
    agentRef: <string>        # name of an EmbeddingAgent in your tenant's agent registry
  chunking:
    tokenSize: <int>          # tokens per chunk (default: 650)
    overlap: <int>            # token overlap between chunks (default: 120)
  retrieval:
    topK: <int>               # chunks returned per similarity query (default: 8)
    citations: <bool>         # include source references in responses (default: true)
```

### EmbeddingAgent

```yaml
apiVersion: arachne-ai.com/v0
kind: EmbeddingAgent
metadata:
  name: <string>              # agent name, used as agentRef in KnowledgeBase specs
spec:
  provider: <string>          # REQUIRED: embedding provider (e.g., openai, azure, cohere)
  model: <string>             # REQUIRED: embedding model name
  knowledgeBaseRef: <string>  # OPTIONAL: this EmbeddingAgent's own KB for meta-context
```

Create and manage EmbeddingAgents in the portal alongside regular Agents, or weave them via the CLI:

```bash
arachne weave my-embedder.yaml         # → dist/my-embedder.orb
arachne push dist/my-embedder.orb --tag 1.0.0
arachne deploy acme/my-embedder:1.0.0 --tenant acme --env prod
```

**Embedder resolution order:**
1. `spec.embedder.agentRef` (if specified in the KnowledgeBase YAML)
2. Tenant's default EmbeddingAgent (if configured in portal)
3. System `system-embedder` (configured via `SYSTEM_EMBEDDER_*` gateway env vars)
4. Error

### Agent

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: <string>              # artifact name
spec:
  model: <string>             # REQUIRED: model identifier (e.g., gpt-4.1-mini)
  systemPrompt: <string>      # OPTIONAL: system prompt text
  knowledgeBaseRef: <string>  # OPTIONAL: name of a KnowledgeBase artifact
```

---

## VectorSpace Determinism

Arachne guarantees that deploying the same bundle always produces identical embeddings.

Each KnowledgeBase bundle records a **VectorSpace contract**:

```json
{
  "embedderProvider": "openai",
  "embedderModel": "text-embedding-3-small",
  "dimensions": 1536,
  "preprocessing": { "tokenSize": 650, "overlap": 120 },
  "vectorSpaceId": "vs_sha256_..."
}
```

The `vectorSpaceId` is the SHA-256 of the embedder config. Arachne uses this to:

- Ensure retrieval queries use the same embedding space as the stored vectors
- Refuse deployments where the KnowledgeBase and runtime embedder don't match
- Detect when a KnowledgeBase needs to be re-woven (embedder model upgrade)

**What Arachne does NOT guarantee:** If you change the embedder model and re-run `arachne weave`, the new bundle will have a different `vectorSpaceId`. The old deployment and the new bundle are incompatible — you must deploy the new bundle to create a new deployment.

---

## Portal Integration

You don't need the CLI to use the artifact system. The Arachne portal provides equivalent functionality:

| CLI Command | Portal Equivalent |
|-------------|-------------------|
| `arachne weave <kb.yaml>` | Knowledge Bases → Upload (file/zip) |
| `arachne push <bundle.orb>` | Knowledge Bases → Upload (auto-pushed after weave) |
| `arachne deploy <artifact:tag>` | Deployments → Provision |
| _(portal only)_ | Agents → Export as YAML |

The **Export as YAML** feature in the Agent Editor generates a pre-filled YAML spec from an existing portal-configured agent. Useful for moving to a CLI-based workflow.

---

## Configuration

Config file: `~/.arachne/config.json`

| Field | Description |
|-------|-------------|
| `gatewayUrl` | Gateway base URL |
| `token` | Portal JWT (stored after `arachne login`) |
| `email` | Authenticated user's email (informational) |

Override the gateway URL for a single command:

```bash
arachne weave support-kb.yaml --gateway https://staging-gateway.example.com
```

---

## Troubleshooting

**`Error: Not authenticated`**  
Run `arachne login <gateway-url>` to authenticate.

**`Error: Token expired`**  
Your JWT has expired. Run `arachne login` again to refresh.

**`Error: Insufficient scope (required: weave:write)`**
Your account doesn't have the required permissions. You need the `owner` role on a tenant to use registry operations. Contact your Arachne administrator.

**`Error: VectorSpace mismatch`**
The deployed KnowledgeBase was embedded with a different model than the one specified in your Agent spec. Re-weave the KnowledgeBase with the matching embedder, push it, and re-deploy.

**`Error: docsPath not found`**
The path in `spec.docsPath` doesn't exist relative to the spec file. Check that the path is correct and the files are present before running `arachne weave`.

**`Error: No embedding provider available`**
**`Error: No EmbeddingAgent found`**
The `spec.embedder.agentRef` you specified doesn't exist, your tenant has no default EmbeddingAgent configured, and the AI Runtime's `SYSTEM_EMBEDDER_*` env vars are not set. Options: (1) create an EmbeddingAgent in the portal and reference it via `agentRef`, (2) set a tenant default EmbeddingAgent in portal settings, or (3) ask your Arachne administrator to configure `SYSTEM_EMBEDDER_PROVIDER`, `SYSTEM_EMBEDDER_MODEL`, and `SYSTEM_EMBEDDER_API_KEY` on the AI Runtime.

**Weave takes too long**
Large document sets will take longer. The AI Runtime streams progress to the CLI. For very large sets, consider splitting your KnowledgeBase into multiple smaller specs.
