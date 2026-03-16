# Arachne Tool Execution Specification (MVP)

## Status

Draft -- MVP Specification

## Overview

Arachne **Tools** enable agents to execute external capabilities in a
controlled, observable, and sandboxed environment. Tools extend an
agent's abilities beyond language reasoning by allowing the agent to
perform operations such as retrieving web data, processing files,
invoking APIs, or interacting with external systems.

Tools are packaged artifacts that contain:

-   tool metadata
-   tool definitions
-   execution handlers
-   bundled dependencies

Tools execute inside a **sandboxed runtime environment** separate from
the agent runtime. This ensures that tool execution is isolated,
auditable, and policy-governed.

This document defines the **MVP architecture and lifecycle** for tool
execution in Arachne.

------------------------------------------------------------------------

# Design Principles

The Arachne tool system is designed around the following principles:

### Isolation

Tools execute in isolated runtime environments separate from the agent
runtime.

### Deterministic contracts

Tool inputs and outputs are strictly defined using JSON schemas.

### Least privilege

Tools only access capabilities explicitly exposed through the execution
context.

### Observability

All tool invocations generate traceable execution records.

### Safety

Tool outputs are treated as **untrusted data by default**.

### Agent-driven orchestration

Agents manage tool sequencing and composition. The runtime executes
**one tool at a time**.

------------------------------------------------------------------------

# Key Concepts

## Tool

A **tool** is an executable capability exposed to an agent.

Each tool defines:

-   name
-   description
-   input schema
-   output schema
-   execution handler

Example:

    web.read

------------------------------------------------------------------------

## Tool Package

Tools are distributed as **packages** containing one or more tools.

A package includes:

-   package manifest
-   tool definitions
-   executable handlers
-   bundled dependencies

Packages are versioned artifacts stored in the **Arachne Registry**.

Example package:

    acme.web-tools

Containing tools:

    web.read
    web.extract
    web.search

------------------------------------------------------------------------

## Tool Host

The **Tool Host** is the runtime responsible for executing tool
handlers.

For MVP:

-   hosted using **Azure Container Apps Dynamic Sessions**
-   execution environment runs **JavaScript**
-   each invocation executes in an isolated sandbox

The tool host does **not** orchestrate tool chains or agents.

------------------------------------------------------------------------

## Tool Invocation

A **tool invocation** is a request by an agent to execute a tool.

Each invocation includes:

-   tool identifier
-   arguments
-   execution context
-   invocation metadata

Each invocation generates a **unique call identifier**.

------------------------------------------------------------------------

# Arachne Registry

The **Arachne Registry** is the system of record for tool packages.

It stores:

-   package metadata
-   tool manifests
-   package versions
-   package artifacts

### Storage model (MVP)

Metadata:

    Postgres

Package blobs:

    Postgres blob storage

Future architecture may migrate package payloads to:

    Azure Blob Storage

while retaining relational metadata in Postgres.

------------------------------------------------------------------------

# Tool Manifest

Each package contains a **manifest** describing the tools it provides.

Example:

``` json
{
  "package": "acme.web-tools",
  "version": "1.0.0",
  "tools": [
    {
      "id": "web.read",
      "name": "Read Web Page",
      "description": "Fetches the content of a webpage.",
      "input_schema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "format": "uri"
          }
        },
        "required": ["url"]
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "content": { "type": "string" }
        }
      },
      "handler": "./handlers/webRead.js"
    }
  ]
}
```

------------------------------------------------------------------------

# Tool Discovery

When an agent executes, the runtime determines which tools the agent is
allowed to use.

The runtime injects tool definitions into the model request.

Injected information includes:

-   tool name
-   description
-   JSON schema
-   usage hints

Example model tool description:

``` json
{
  "name": "web.read",
  "description": "Fetch the content of a webpage.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string"
      }
    },
    "required": ["url"]
  }
}
```

------------------------------------------------------------------------

# Tool Execution Lifecycle

## Step 1 --- Agent requests tool invocation

The model returns a tool call:

``` json
{
  "tool": "acme.web-tools/web.read",
  "arguments": {
    "url": "https://example.com"
  }
}
```

------------------------------------------------------------------------

## Step 2 --- Runtime validation

The Arachne runtime validates the request.

Validation includes:

-   tool existence
-   agent authorization
-   package version resolution
-   input schema validation
-   policy checks
-   execution quota checks

If validation fails, the runtime returns an error result.

------------------------------------------------------------------------

## Step 3 --- Invocation payload generation

The runtime generates an invocation request.

Example:

``` json
{
  "call_id": "call_123",
  "trace_id": "trace_abc",
  "agent_id": "research-agent",
  "tool": {
    "package_id": "acme.web-tools",
    "package_version": "1.0.0",
    "tool_id": "web.read"
  },
  "args": {
    "url": "https://example.com"
  },
  "limits": {
    "timeout_ms": 15000,
    "max_output_bytes": 200000
  }
}
```

------------------------------------------------------------------------

## Step 4 --- Session allocation

The runtime invokes the **Tool Host**.

Execution uses **Azure Container Apps Dynamic Sessions**.

### Session strategy (MVP)

Tool execution is **per invocation and stateless**.

Each invocation uses a unique identifier derived from the call ID.

Example:

    toolcall-{call_id}

This guarantees isolation.

The platform does not assume session reuse even if the underlying
infrastructure reuses warmed containers.

------------------------------------------------------------------------

## Step 5 --- Tool handler resolution

Inside the session runtime:

1.  The package is loaded
2.  The tool manifest is read
3.  The handler entry point is resolved
4.  The execution context is constructed

------------------------------------------------------------------------

## Step 6 --- Tool execution

The tool handler executes.

Handler signature:

``` ts
export async function handler(args, context) {
  // tool logic
}
```

The handler receives:

-   validated arguments
-   a restricted execution context

The handler returns structured output.

Example:

``` json
{
  "content": "Example webpage content..."
}
```

------------------------------------------------------------------------

## Step 7 --- Result capture

The session captures:

-   returned data
-   logs
-   artifacts
-   metrics
-   errors

------------------------------------------------------------------------

## Step 8 --- Result sanitization

Before returning results to the agent, the runtime performs
sanitization.

Sanitization includes:

-   output schema validation
-   output size limits
-   secret redaction
-   trust labeling
-   provenance metadata

------------------------------------------------------------------------

## Step 9 --- Result returned to agent

The sanitized result is returned to the agent loop.

Example:

``` json
{
  "call_id": "call_123",
  "status": "ok",
  "trust": "untrusted",
  "data": {
    "content": "Example webpage content..."
  },
  "provenance": {
    "package_id": "acme.web-tools",
    "package_version": "1.0.0",
    "tool_id": "web.read"
  }
}
```

The agent may then:

-   answer the user
-   invoke another tool
-   combine results

------------------------------------------------------------------------

# Trust Model

Tool output is **untrusted by default**.

This applies to:

-   internal tools
-   external tools
-   tools processing user input
-   tools accessing external sources

The runtime must treat tool outputs as potentially adversarial content.

Future versions of the platform may introduce stronger trust tiers.

------------------------------------------------------------------------

# Error Handling

Tool execution errors must return a structured envelope.

Example:

``` json
{
  "call_id": "call_123",
  "status": "error",
  "error": {
    "code": "TOOL_TIMEOUT",
    "message": "Tool execution exceeded the allowed timeout.",
    "retryable": false,
    "category": "execution"
  },
  "provenance": {
    "package_id": "acme.web-tools",
    "package_version": "1.0.0",
    "tool_id": "web.read"
  }
}
```

------------------------------------------------------------------------

# Execution Context API

``` ts
interface ToolContext {
  invocation: {
    id: string
    traceId: string
    packageId: string
    packageVersion: string
    toolId: string
    tenantId: string
  }

  logger: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }

  artifacts: {
    put(input: {
      data: string | Uint8Array
      contentType: string
      name?: string
    }): Promise<{ artifactId: string }>

    get(artifactId: string): Promise<{
      data: string | Uint8Array
      contentType: string
      name?: string
    }>
  }

  secrets: {
    get(name: string): Promise<string>
  }

  host: {
    web: {
      fetch(input: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
      }): Promise<{
        status: number
        headers: Record<string, string>
        text(): Promise<string>
        json(): Promise<unknown>
      }>
    }

    time: {
      now(): string
    }
  }
}
```

------------------------------------------------------------------------

# Observability

Each tool invocation generates a durable execution record including:

-   call ID
-   trace ID
-   package version
-   tool identifier
-   validated arguments
-   execution status
-   execution duration
-   generated artifacts
-   sanitized output
-   error details (if applicable)

These records support:

-   debugging
-   evaluation systems
-   replay
-   governance
-   enterprise audit

------------------------------------------------------------------------

# Future Enhancements

Planned future capabilities include:

-   Tool-to-tool chaining
-   Agent invocation from tools
-   WASM runtime support
-   Tool signing and verification
-   Persistent tool sessions
-   Advanced trust tiers

------------------------------------------------------------------------

# Summary

The Arachne tool system enables agents to safely interact with external
capabilities through:

-   versioned tool packages
-   sandboxed execution environments
-   strict input/output contracts
-   structured error handling
-   observable execution traces

This architecture provides a secure and extensible foundation for agent
capabilities while maintaining strong isolation and governance
guarantees.
