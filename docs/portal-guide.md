# Portal User Guide

The Arachne Portal is a web-based dashboard for managing agents, knowledge bases, API keys, conversations, and analytics. Access it at `https://api.arachne-ai.com` after logging in.

## Dashboard Overview

The portal is organized into these main sections:

- **Agents** — Define and configure agents with custom system prompts, tools, and merge policies
- **Knowledge Bases** — View and manage deployed knowledge bases for RAG retrieval
- **Deployments** — Deploy and manage artifact deployments across environments
- **API Keys** — Create and revoke API keys for programmatic access
- **Conversations** — Browse multi-turn conversation history
- **Analytics** — View request volume, token usage, costs, and latency metrics
- **Settings** — Manage tenant info, org slug, and provider configuration

## Knowledge Bases Page

The **Knowledge Bases** page shows all vectorized document collections available to your agents for retrieval-augmented generation (RAG).

### What You See

A table with:

| Column | Meaning |
|--------|---------|
| **Name** | Knowledge base identifier (e.g., `product-docs`, `support-kb`) |
| **Org** | Organization slug that owns the KB |
| **Version** | ISO timestamp of when the KB was published |
| **Chunks** | Number of text chunks the KB was split into |
| **Vector Space** | Embedding provider and model (e.g., `openai / text-embedding-3-small`) |
| **Created** | Deployment date and time |
| **Actions** | Delete button |

### Creating a Knowledge Base

Knowledge bases can be created directly in the portal or via the CLI.

#### Via the Portal

1. Click the **+ New Knowledge Base** button in the page header
2. Enter a **name** for the knowledge base (e.g., `product-docs`, `support-kb`)
3. **Drag and drop files** into the drop zone, or click to browse
   - Accepted formats: `.txt`, `.md`, `.json`, `.csv`
   - Multiple files can be uploaded at once
4. Review the selected files list (click **x** to remove any)
5. Click **Create**

The portal will automatically:
- Chunk all file contents (650 tokens per chunk, 120 token overlap)
- Generate embeddings using the configured system embedder
- Push the knowledge base to the registry with a `latest` tag

**Requirements:** A system embedder must be configured (`SYSTEM_EMBEDDER_PROVIDER`, `SYSTEM_EMBEDDER_MODEL`, `SYSTEM_EMBEDDER_API_KEY` env vars). If not configured, an error message will appear.

#### Via the CLI

```bash
# 1. Define a YAML spec
cat > my-kb.yaml <<EOF
apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: my-kb
spec:
  docsPath: ./docs              # Directory or .zip file
  chunking:
    tokenSize: 650              # Tokens per chunk
    overlap: 120                # Token overlap between chunks
  retrieval:
    topK: 5                     # Top-K chunks to retrieve at query time
    citations: true
EOF

# 2. Weave the KB (chunking, embedding, signing)
arachne weave my-kb.yaml

# 3. Push to registry
arachne push my-kb.tgz \
  --name my-kb \
  --org my-org \
  --tag v1.0

# 4. Deploy
arachne deploy my-org/my-kb:v1.0 \
  --environment production
```

The KB will appear on this page once created or deployed.

See [docs/registry-api.md](registry-api.md) and [docs/cli.md](cli.md) for full details.

### Deleting a Knowledge Base

Click the **Delete** button on the KB row. Confirm when prompted.

⚠️ **Warning:** Deleting a KB will break any agents using that KB for RAG. Remove the `knowledgeBaseRef` from those agents first.

## Deployments Page

The **Deployments** page shows all active artifact deployments. Each deployment is a running instance of a published artifact (knowledge base, agent, or embedder) with a runtime token.

### What You See

A table with:

| Column | Meaning |
|--------|---------|
| **Artifact** | Full artifact reference (e.g., `my-org/my-kb:v1.0`) |
| **Env** | Deployment environment (`prod`, `staging`, `dev`) |
| **Status** | `READY` (working) or `FAILED` (error occurred) |
| **Deployed** | Deployment timestamp |
| **Actions** | Undeploy button |

### What Is a Deployment?

A **deployment** is an immutable snapshot of an artifact version at a specific point in time. When you deploy:

1. The artifact is resolved from the registry
2. A unique `deploymentId` is generated
3. A scoped JWT token (`runtimeToken`) is minted with 1-year expiry
4. The deployment status is recorded

Deployments enable safe artifact rollbacks and multi-environment management. Each environment has its own set of deployments with independent tokens.

### Deploying an Artifact

1. Click **+ Deploy new** button
2. Fill in:
   - **Org** — Organization slug (pre-filled with your org)
   - **Artifact name** — e.g., `my-kb`, `my-agent`
   - **Tag / version** — e.g., `latest`, `v1.0`, `production`
   - **Environment** — `prod`, `staging`, or `dev`
3. Click **Deploy**

The deployment will appear in the table with status `READY` if successful, or `FAILED` with an error message if something went wrong.

**Common errors:**

- `Artifact not found` — No artifact with that org/name/tag in the registry
- `Knowledge base has no chunks loaded` — The KB bundle has no chunks (corrupted bundle or weaving failed)

### Using a Deployment

Once deployed, you can:

- **Attach to agents** — Select the KB in the agent editor's "Knowledge Base" dropdown to enable RAG
- **Query at inference time** — The deployment's runtime token is embedded in the KB context and used for access control

### Undeploying

Click **Undeploy** to stop a deployment and revoke its runtime token. This will immediately break agents using that deployment unless you switch them to a different KB first.

## Agent Editor

The **Agent Editor** is the primary interface for configuring agents. Click on an agent name to open it, or create a new agent via the **+ Create new agent** button.

### Agent Configuration Fields

| Field | Purpose |
|-------|---------|
| **Name** | Agent identifier (used in API requests and traces) |
| **System Prompt** | Custom instructions injected into every request |
| **Model** | LLM to use (e.g., `gpt-4o`, `gpt-4o-mini`) |
| **Skills/Tools** | MCP tool definitions for agent to call |
| **MCP Endpoints** | URLs of MCP servers hosting tools |
| **Merge Policies** | How to combine agent context with request (prepend/append/overwrite) |
| **Knowledge Base** | Attach a deployed KB for RAG retrieval |
| **Conversations** | Enable multi-turn memory and summarization |

### Attaching a Knowledge Base

1. Scroll to the **Knowledge Base** section
2. Click the dropdown and select a deployed KB from the list
3. The selected KB name appears in the selector
4. Click **Save Agent**

Once attached:
- User queries will be embedded at request time
- Top-K chunks from the KB will be retrieved
- Retrieved chunks will be injected into the system prompt before the request goes to the LLM
- The agent's responses will cite sources from the KB

To remove a KB, click the **Clear** button and save.

### Export YAML Button

The **Export YAML** button at the top of the editor downloads the agent configuration as an Arachne YAML spec:

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: my-agent
spec:
  model: gpt-4o
  systemPrompt: |
    You are a helpful assistant...
  knowledgeBaseRef: my-kb
  temperature: 0.7
  maxTokens: 2000
```

You can use this YAML to:
- **Version control** — Commit agent specs to Git
- **Reproduce locally** — Share agent configs with teammates
- **Weave into bundles** — Publish the agent to the registry

## Agent Configuration Inheritance

Agents inherit context from their tenant's default configuration:

**Resolution order for provider config:**
1. Agent's own `providerConfig` (if set)
2. Tenant's default `providerConfig`
3. Parent tenant's default (if subtenant)
4. Error if none configured

**Resolution order for system prompt:**
1. Agent's system prompt
2. Tenant's default system prompt
3. Parent tenant's default (if subtenant)

**Skills and MCP endpoints:** Merged (agent + tenant defaults, de-duplicated)

**Merge policies:** Agent-only (not inherited)

This allows you to set defaults for all agents in your tenant while still customizing individual agents.

## Conversations

The **Conversations** page shows multi-turn conversation history. Each conversation is a thread of messages exchanged with an agent.

Conversations can be:
- **Partitioned** — Organized by external ID (e.g., by user ID, document, session)
- **Summarized** — When they exceed the token limit, earlier messages are auto-summarized to preserve context
- **Encrypted** — All message content is encrypted at rest

Click on a conversation to view the full thread with latency and token metrics per turn.

## Analytics

The **Analytics** page provides observability into usage:

- **Request volume** — Chart of requests over time (by day, hour, etc.)
- **Token consumption** — Prompt, completion, and total tokens
- **Cost estimation** — Per-request and aggregated cost based on model-specific rates
- **Latency** — P50, P95, P99 response times
- **Error rate** — Percentage of requests with status >= 400
- **Model breakdown** — Usage by model (GPT-4o, GPT-4o-mini, etc.)

Apply filters to view metrics for specific agents, environments, or time ranges.

## Settings

The **Settings** page manages organization identity and tenant-level configuration. It is divided into two sections: **Organization** (name and slug) and **Org Defaults** (provider config and available models).

### Organization Name & Slug

The **Organization** section lets you view and edit your organization's display name and URL slug.

**Organization Name:** The display name of your organization, shown in the portal and used as the default seed for generating a slug.

**Organization Slug:** A URL-safe identifier for your organization, used in artifact references and API calls. Every organization must have a unique slug to prevent artifact name collisions in the registry.

**What it is:**

The org slug appears in all artifact references:
```
{org_slug}/{artifact_name}:{tag}
```

**Example:** In `acme-corp/product-docs:v1.0`, the org slug is `acme-corp`.

**Rules:**

- **3–50 characters** — Minimum 3, maximum 50
- **Lowercase alphanumeric + hyphens only** — No spaces, underscores, or special characters
- **No leading or trailing hyphens** — Must start and end with alphanumeric character
- **Unique across Arachne** — Cannot be claimed by another organization
- **Suggested format:** Company name in kebab-case (e.g., `my-company`, `acme-corp`, `project-x`)

**Examples of valid slugs:**
- `acme-corp`
- `my-org`
- `engineering-team`
- `org123`

**Examples of invalid slugs:**
- `-leading-hyphen` (leading hyphen)
- `trailing-hyphen-` (trailing hyphen)
- `My Corp` (spaces and capitals)
- `org_with_underscore` (underscores)
- `ab` (too short)

### How to Set or Update Your Org Name & Slug

**Via the Portal:**

1. Go to **Settings**
2. In the **Organization** card:
   - Edit the **Name** field — typing auto-generates the slug if it hasn't been manually set
   - Edit the **Slug** field directly, or click **Auto-generate** to regenerate from the name
   - Inline validation shows errors as you type
3. Click **Save**

Both the name and slug are updated immediately. All future artifact publishes will use the new slug.

**Via the CLI:**

You specify the org slug when publishing artifacts:

```bash
arachne push my-kb.tgz \
  --name product-docs \
  --org acme-corp \      # This is your org slug
  --tag v1.0
```

### Org Slug Validation

If your slug is invalid, you'll see an error message:

- `Slug must be at least 3 characters` — Increase the length
- `Slug must be 50 characters or less` — Make it shorter
- `Slug must be lowercase alphanumeric with hyphens only (no leading/trailing hyphens)` — Fix formatting
- `Slug is already taken` — Choose a different slug

**Changing your org slug:**

⚠️ **Important:** If you change your org slug, all **future** artifact references must use the new slug. **Existing published artifacts remain under the old slug** and are not automatically migrated. To prevent broken references:

1. Update agents and deployments to point to the new org slug before releasing a new version
2. Publish new artifacts with the new slug
3. Gradually deprecate old artifacts under the old slug
4. Document the migration for users of your API

### Provider Configuration

Specify API keys and endpoints for LLM providers (OpenAI, Azure, etc.). This is inherited by all agents in your tenant unless they override it.

### Subtenant Management

Parent tenants can create child subtenants (e.g., separate divisions, clients, or projects). Each subtenant has isolated data and agents, with optional analytics rollup to the parent.

See the **Subtenants** page (owner role only) to manage the hierarchy.

## API Keys

The **API Keys** page shows all tokens with access to your tenant's gateway endpoints.

Each key is bound to exactly one agent and grants permissions to call `/v1/chat/completions` with that agent.

**To create a key:**
1. Click **+ Create new API key**
2. Name it (e.g., `production-key`, `integration-test`)
3. Select an agent from the dropdown
4. Click **Create**
5. Copy the key (it won't be shown again; store it securely)

**To revoke a key:**
Click the **Revoke** button. The key becomes invalid immediately for all future requests.

## Help & Support

- **Docs**: See [docs/](../docs/) for CLI reference, architecture, and troubleshooting
- **Traces**: View encrypted request/response traces per agent in the **Traces** tab (admin users only)
- **Feedback**: Report issues or request features via email to support@arachne-ai.com
