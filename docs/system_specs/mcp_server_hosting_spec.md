# Arachne MCP Server Hosting Specification

*Synaptic Weave, Inc.*
*Version 0.1 — Working Draft*
*Last updated: 2026-03-24*

---

> This spec defines how any deployed Arachne agent can be exposed as a standards-compliant MCP server. The agent's skills become MCP tools, its knowledge bases become MCP resources, and its trace log provides full observability. M365 is the first implementation.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Design Principles](#2-design-principles)
3. [Agent Configuration](#3-agent-configuration)
4. [MCP Protocol Implementation](#4-mcp-protocol-implementation)
5. [Transport Layer](#5-transport-layer)
6. [Authentication](#6-authentication)
7. [Trace Recording](#7-trace-recording)
8. [Deployment Model Integration](#8-deployment-model-integration)
9. [M365 First Implementation](#9-m365-first-implementation)
10. [Implementation Phases](#10-implementation-phases)
11. [Open Questions](#11-open-questions)

---

## 1. Motivation

Arachne agents currently have one-directional MCP: they can **call out** to external MCP servers via `handleMcpRoundTrip()`. But agents cannot **be called** as MCP servers. This means an Arachne-hosted agent with powerful skills (e.g., M365 Graph API, database access, domain-specific tools) cannot be consumed by external MCP clients like Claude Code, Cursor, or other agentic systems.

MCP Server Hosting closes this gap. Any deployed Arachne agent becomes addressable as a standards-compliant MCP server. The agent's skills become MCP tools, its knowledge bases become MCP resources, and its trace log provides full debugging history. The agent acts as a **bridge**: an MCP client calls the agent, the agent's LLM reasons over the request (optionally), and the agent can call out to its own MCP endpoints or external APIs to fulfill the request.

---

## 2. Design Principles

1. **Agent-agnostic.** The MCP server capability is a runtime feature, not tied to any specific agent configuration. Any agent with skills can be exposed.
2. **Zero agent code changes.** Existing agents gain MCP server capability through configuration, not code modification.
3. **Leverage existing primitives.** Authentication uses the existing API key and runtime token model. Tracing uses the existing `TraceRecorder`. Tenant isolation uses the existing partition model.
4. **Transport-flexible.** Support stdio for local development (Claude Code MCP config) and HTTP+SSE for remote production use.
5. **Faithful mapping.** Agent skills map directly to MCP tools. The mapping is mechanical, not lossy.
6. **Stateless, observable.** MCP sessions are stateless (standard compliant). Full trace logging provides debugging history without conversation memory accumulation.

---

## 3. Agent Configuration

### 3.1 New Field: `mcpServerConfig`

Add an optional `mcpServerConfig` field to the Agent entity:

```typescript
interface McpServerConfig {
  enabled: boolean;

  // Which skills to expose (default: all)
  exposedSkills?: string[];   // allowlist
  excludedSkills?: string[];  // denylist

  // Whether to expose KBs as MCP resources
  exposeKnowledgeBases?: boolean;  // default: true

  // Whether to expose tool packages as MCP tools
  exposeToolPackages?: boolean;    // default: false
  toolPackageRefs?: string[];      // allowlist (omit = all referenced packages)

  // Transport configuration
  transports?: {
    stdio?: boolean;
    http?: {
      enabled: boolean;
      pathPrefix?: string;  // default: /v1/mcp/{agentId}
    };
  };

  // Rate limits specific to MCP access
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerDay?: number;
  };
}
```

### 3.2 Why a Config Object, Not a Deployment Flag

MCP server hosting is an **exposure mode** of an already-deployed agent, not a separate deployment. The same agent can simultaneously serve:
- OpenAI-compatible `/v1/chat/completions` requests (existing path)
- MCP protocol requests (new path)

Both paths resolve to the same agent context, same tenant, same provider chain.

### 3.3 Database Migration

```sql
CREATE TABLE mcp_server_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  exposed_skills TEXT[] DEFAULT NULL,     -- allowlist (NULL = all)
  excluded_skills TEXT[] DEFAULT NULL,    -- denylist
  expose_knowledge_bases BOOLEAN NOT NULL DEFAULT true,
  expose_tool_packages BOOLEAN NOT NULL DEFAULT false,
  tool_package_refs TEXT[] DEFAULT NULL,  -- which tool packages to expose
  transport_stdio BOOLEAN NOT NULL DEFAULT false,
  transport_http BOOLEAN NOT NULL DEFAULT true,
  http_path_prefix VARCHAR(255) DEFAULT NULL, -- override default /v1/mcp/{agentId}
  rate_limit_rpm INTEGER DEFAULT NULL,    -- requests per minute
  rate_limit_tpd INTEGER DEFAULT NULL,    -- tokens per day
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id)
);
```

Separate table keeps the agents table clean and allows the MCP config to evolve independently. The `UNIQUE(agent_id)` constraint ensures one MCP config per agent. An agent without a row in this table has MCP server hosting disabled (backward compatible).

---

## 4. MCP Protocol Implementation

### 4.1 Supported Methods

| Method | Description | Source |
|--------|-------------|--------|
| `initialize` | Capability negotiation and session setup | Static capabilities declaration |
| `tools/list` | List available tools | Agent skills + tool packages, filtered by `mcpServerConfig` |
| `tools/call` | Execute a tool | Skills: LLM-mediated or direct. Tool packages: always direct (sandboxed). |
| `resources/list` | List available resources | Agent's KBs (if `exposeKnowledgeBases: true`) |
| `resources/read` | Read a resource | KB chunk retrieval via existing RAG pipeline |
| `ping` | Health check | Returns `{}` |

### 4.2 `initialize` Flow

```json
// Client request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "roots": { "listChanged": true } },
    "clientInfo": { "name": "claude-code", "version": "1.0.0" }
  }
}

// Server response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": { "listChanged": false },
      "resources": { "subscribe": false, "listChanged": false }
    },
    "serverInfo": {
      "name": "arachne-mcp/{agentName}",
      "version": "0.1.0"
    }
  }
}
```

### 4.3 Skills-to-Tools Mapping

Agent skills (OpenAI tool format) map mechanically to MCP tool format:

```typescript
function skillToMcpTool(skill: any): McpTool {
  const fn = skill.function ?? skill;
  return {
    name: fn.name,
    description: fn.description ?? '',
    inputSchema: fn.parameters ?? { type: 'object', properties: {} },
  };
}
```

### 4.4 `tools/call` Execution Model

Two modes, configurable per tool:

**LLM-mediated (default):** The MCP server constructs a chat completion request with the tool call, sends it through the existing agent pipeline (system prompt + RAG + provider), and extracts the result. The agent's LLM validates, transforms, or refuses the request. Preserves system prompt guardrails.

```
MCP Client → tools/call → Arachne MCP Server → chat/completions → Agent LLM → External Tool
                                              ← response ←          ← tool_result ←
```

**Direct execution:** The tool handler executes immediately without LLM reasoning. Faster and cheaper, for latency-sensitive tools where the caller handles all reasoning.

Configured via a `directExecution` flag per skill in the agent definition.

### 4.5 KB-to-Resources Mapping

If `exposeKnowledgeBases: true`:

```json
{
  "resources": [
    {
      "uri": "arachne://kb/{knowledgeBaseRef}",
      "name": "Agent Knowledge Base",
      "description": "Semantic search over the agent's knowledge base",
      "mimeType": "text/plain"
    }
  ]
}
```

`resources/read` performs semantic search using the existing RAG pipeline. The `uri` supports a query parameter: `arachne://kb/{ref}?q=search+terms`.

### 4.6 Tool Packages as MCP Tools

Arachne tool packages (see `arachne_tool_package_spec.md`) are sandboxed, portable executables distributed through the Arachne Registry. When `expose_tool_packages` is enabled in the MCP server config, the agent's referenced tool packages are exposed as MCP tools alongside (or instead of) its skills.

**Key differences from skills:**

| Aspect | Skills (existing) | Tool Packages |
|--------|-------------------|---------------|
| Execution | LLM-mediated or direct | Always direct (sandboxed execution) |
| Definition | OpenAI tool format in agent spec | Package manifest with JSON Schema I/O |
| Runtime | Runs in agent's LLM context | Runs in isolated sandbox (Deno/V8) |
| Distribution | Inline in agent spec | Published to Arachne Registry |

**Mapping to MCP tools:**

```typescript
function toolPackageToMcpTool(pkg: ToolPackageManifest, tool: ToolDef): McpTool {
  return {
    name: `${pkg.name}/${tool.name}`,  // namespaced to avoid collisions
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}
```

Tool names are namespaced as `{package-name}/{tool-name}` to avoid collisions with agent skills. For example, a tool package `synaptic-weave.graph-tools` with a tool `query_graph` becomes the MCP tool `synaptic-weave.graph-tools/query_graph`.

**Execution flow:**

```
MCP Client -> tools/call -> Arachne MCP Server -> Tool Package Sandbox -> result
```

Tool package execution is always direct (no LLM mediation) because tool packages define their own input validation via JSON Schema. The sandbox handles execution isolation, timeout enforcement, and output capture.

**Configuration:**

```yaml
mcpServer:
  enabled: true
  exposeToolPackages: true
  toolPackageRefs:
    - synaptic-weave.graph-tools@1.0.0
    - synaptic-weave.data-transforms@latest
```

If `toolPackageRefs` is omitted, all tool packages referenced by the agent are exposed. If specified, only the listed packages are exposed (allowlist).

**Standalone tool package servers (no agent):**

A tool package can also be exposed as a standalone MCP server without an agent. This is useful for utility packages (data transforms, validators, formatters) that don't need LLM reasoning:

```bash
arachne mcp-serve --tool-package synaptic-weave.graph-tools --api-key loom_sk_...
```

In this mode, the MCP server exposes only the tool package's tools (no skills, no KBs, no LLM). Authentication still uses the standard API key or runtime token model for tenant isolation and tracing.

---

## 5. Transport Layer

### 5.1 HTTP+SSE Transport (Remote)

New Fastify route:

```
POST /v1/mcp/{agentId}       — JSON-RPC 2.0 endpoint
GET  /v1/mcp/{agentId}/sse   — SSE stream for server-initiated notifications
```

Follows the MCP Streamable HTTP transport specification. Session management via `Mcp-Session-Id` header.

### 5.2 stdio Transport (Local)

New CLI command:

```bash
# Agent mode (skills + tool packages + KBs)
arachne mcp-serve --agent <agent-id-or-name> --api-key <key>

# Standalone tool package mode (no agent, no LLM)
arachne mcp-serve --tool-package <package-ref> --api-key <key>
```

Thin stdin/stdout proxy to the HTTP endpoint. All logic (auth, mapping, execution, tracing) lives in one place on the server.

**Claude Code MCP config:**
```json
{
  "mcpServers": {
    "my-arachne-agent": {
      "command": "arachne",
      "args": ["mcp-serve", "--agent", "m365-assistant", "--api-key", "loom_sk_..."]
    }
  }
}
```

---

## 6. Authentication

### 6.1 Inbound: MCP Client to Arachne

Two existing mechanisms, no changes needed:

1. **API Key auth** — `Authorization: Bearer loom_sk_...` — resolves via existing `TenantService.loadByApiKey()` with LRU cache
2. **Runtime token auth** — `Authorization: Bearer <jwt>` — for deployment-backed agents via `resolveRuntimeContext()`

### 6.2 Outbound: Agent to External Services (Per-Principal OAuth)

**Dependency:** Requires the Principal system (principals mapped to partitions) to be implemented.

**Auth layer:** Arachne's unified auth system with OIDC SSO for principal/identity management (see `unified_auth_spec.md`).

**OAuth token model: per-principal, not per-agent.**

The agent does not hold a single OAuth token. Each principal (end user) independently authorizes the agent to access services on their behalf.

**Flow:**

1. Principal authenticates to Arachne via unified auth (session JWT or SSO)
2. Principal grants agent access to M365 (OAuth consent flow)
3. Agent stores M365 refresh token **per principal** in credential store (encrypted)
4. At runtime: gateway token -> resolve principal -> lookup that principal's M365 token -> agent uses it for Graph API calls

**Must work across three deployment modes:**
- **Hosted** (Arachne cloud): Unified auth with OIDC SSO handles identity, Arachne manages credential store
- **Enterprise** (self-hosted): Customer's identity provider via OIDC SSO federation, credential store in customer's database
- **Desktop** (local/Ollama): Local credential store, OAuth device flow or browser redirect

### 6.3 Agent Credential Store

New table for storing per-principal OAuth tokens:

```sql
CREATE TABLE agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  principal_id UUID NOT NULL,  -- references principals table
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,  -- e.g., "microsoft_graph"
  type VARCHAR(50) NOT NULL DEFAULT 'oauth2',
  encrypted_data TEXT NOT NULL, -- JSON: { access_token, refresh_token, expires_at, ... }
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, principal_id, name)
);
```

Encrypted at rest using existing per-tenant key derivation (AES-256-GCM).

---

## 7. Trace Recording

MCP-served requests use the existing `TraceRecorder` with new fields:

```typescript
interface TraceInput {
  // ... existing fields ...
  source?: 'chat_completions' | 'mcp_server';
  mcpMethod?: string;         // e.g., "tools/call"
  mcpToolName?: string;       // e.g., "send_email"
  mcpClientInfo?: string;     // e.g., "claude-code/1.0.0"
  mcpSessionId?: string;
}
```

Every `tools/call` generates a trace: MCP request, internal LLM request/response (if mediated), outbound API calls, latency, token usage, cost. Full observability without session statefulness.

---

## 8. Deployment Model Integration

### 8.1 Agent Spec Extension

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: m365-assistant
spec:
  model: gpt-4o
  systemPrompt: |
    You are a Microsoft 365 assistant.
  skills:
    - name: send_email
      description: Send an email via Microsoft Graph API
      directExecution: false  # LLM-mediated (default)
      parameters:
        type: object
        properties:
          to: { type: string }
          subject: { type: string }
          body: { type: string }
        required: [to, subject, body]

  mcpServer:
    enabled: true
    exposeKnowledgeBases: true
    transports:
      http:
        enabled: true
```

The `weave` command includes this in artifact metadata. The deploy pipeline carries it through to agent context.

---

## 9. M365 First Implementation

### 9.1 Tools

- **Mail:** `list_emails`, `read_email`, `send_email`, `reply_email`, `search_emails`
- **Calendar:** `list_events`, `create_event`, `update_event`, `find_free_slots`
- **Files:** `list_files`, `read_file`, `upload_file`, `search_files`
- **Teams:** `send_teams_message`, `list_channels`, `read_channel`

### 9.2 OAuth Setup

1. Admin configures Azure AD app registration with Microsoft Graph permissions
2. Principal navigates to Arachne portal → Agent → Authorize M365
3. Redirect to Microsoft OAuth consent page
4. On callback, Arachne stores refresh token in `agent_credentials` scoped to that principal
5. At runtime, credential service refreshes access token before each API call

### 9.3 Azure AD App Registration Requirements

- Application type: Web
- Redirect URI: `{arachne-host}/v1/oauth/callback/microsoft`
- API permissions: `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite`, `ChannelMessage.Send`, `Chat.ReadWrite`
- Grant type: Authorization code flow with PKCE

---

## 10. Implementation Phases

**Phase 1 — Core MCP Server (2-3 sprints):**
- Database migration: `mcp_server_config` column
- MCP protocol handler: `src/mcp/` directory (protocol.ts, handlers.ts, mapping.ts)
- HTTP transport: `src/routes/mcp.ts`
- Trace integration: extend `TraceInput`
- Tests: unit + integration for protocol compliance

**Phase 2 — stdio Transport + CLI (1 sprint):**
- CLI command: `arachne mcp-serve`
- stdio proxy: thin stdin/stdout client
- Documentation: Claude Code config examples

**Phase 3 — Agent Credential Store + M365 (2-3 sprints):**
- Database migration: `agent_credentials` table
- Credential service: CRUD, encryption, token refresh
- OAuth flow: portal UI for consent redirect/callback
- M365 tool implementations
- Agent template: `arachne init --template m365`

**Phase 4 — Portal UI + Polish (1 sprint):**
- MCP server config in agent edit page
- Credential management UI
- Connection testing button

---

## 11. Open Questions

1. **Multi-agent MCP** — Should a single MCP endpoint expose tools from multiple agents (e.g., M365 + Salesforce behind one server)?
2. **ACP bridge** — When the Agent Service Bus is implemented, should MCP `tools/call` be bridgeable to internal multi-agent workflows?
3. **Auth integration** — How does the unified auth system's OIDC SSO interact with per-principal credential storage? Does the Principal primitive map to an authenticated user or a separate identity?
4. **Desktop OAuth** — For local/Ollama deployments without a web server, use OAuth device flow or local browser redirect?

---

*End of MCP Server Hosting Specification v0.1*
