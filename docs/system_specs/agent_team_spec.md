# Arachne Agent Team Specification

> Tracked by Epic [#TBD]

## Status

Draft -- MVP Specification

**Author:** Arachne Team
**Last Updated:** 2026-03-21

------------------------------------------------------------------------

## Overview

An **AgentTeam** is an artifact kind that bundles multiple agent
references with a coordination pattern. When deployed, it provisions all
member agents, configures channels, and exposes a single API endpoint
that orchestrates requests across the team.

AgentTeam follows the same weave/push/deploy lifecycle as Agents and
KnowledgeBases. It participates in the workspace dependency graph as a
layer above individual Agents.

------------------------------------------------------------------------

## Design Goals

1.  **First-class artifact:** AgentTeam uses the standard
    `apiVersion`/`kind`/`metadata`/`spec` format and produces `.orb`
    bundles through the existing CLI pipeline.
2.  **Declarative coordination:** Patterns are defined in YAML, not
    code. The runtime interprets the pattern and manages execution flow.
3.  **Transparent tracing:** Each sub-agent invocation produces its own
    trace row, linked to the team-level trace by `parentRequestId`.
4.  **Backward compatible:** Existing Agent and KnowledgeBase specs are
    unchanged. AgentTeam is purely additive.
5.  **Workspace-aware:** AgentTeam participates in the dependency graph
    and its member refs are resolved during weave (local workspace
    first, registry fallback second).

------------------------------------------------------------------------

## Spec Format

### Full Example

```yaml
apiVersion: arachne-ai.com/v0
kind: AgentTeam
metadata:
  name: customer-support-team
spec:
  coordination: routing

  router:
    agent: triage-agent
    model: gpt-4.1-mini
    systemPrompt: |
      Classify the user's intent and route to the appropriate specialist.
      Available specialists: billing, technical, general.
    routes:
      - intent: billing
        agent: billing-agent
      - intent: technical
        agent: tech-support-agent
      - intent: general
        agent: general-agent
    fallback: general-agent

  agents:
    - ref: triage-agent
    - ref: billing-agent
    - ref: tech-support-agent
    - ref: general-agent

  channels:
    - name: customer-intake
      pattern: broadcast
    - name: classified-tickets
      pattern: directed

  sharedKnowledgeBases:
    - company-policies-kb
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiVersion` | string | Must be `arachne-ai.com/v0` |
| `kind` | string | Must be `AgentTeam` |
| `metadata.name` | string | Unique name for the team artifact |
| `spec.coordination` | enum | One of: `routing`, `handoff`, `parallel`, `supervisor` |
| `spec.agents` | array | List of agent references (`ref: name`) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `spec.router` | object | Configuration for the routing pattern (required when `coordination: routing`) |
| `spec.pipeline` | array | Ordered list of pipeline stages (required when `coordination: handoff`) |
| `spec.workers` | array | List of parallel workers (required when `coordination: parallel`) |
| `spec.merge` | object | Merge agent configuration (required when `coordination: parallel`) |
| `spec.supervisor` | object | Supervisor configuration (required when `coordination: supervisor`) |
| `spec.channels` | array | Named communication channels between agents |
| `spec.sharedKnowledgeBases` | array | KBs available to all member agents during execution |

------------------------------------------------------------------------

## Coordination Patterns

AgentTeam supports four coordination patterns. Each pattern defines how
requests flow between member agents.

### Routing

A router agent receives the initial request, classifies intent via LLM
call, and dispatches to the appropriate specialist. The specialist's
response becomes the final response.

**Flow:**

1.  Request arrives at the team endpoint.
2.  Router agent receives the request with classification instructions.
3.  Router's structured output includes the selected intent.
4.  TeamOrchestrator matches the intent to a route entry.
5.  Specialist agent processes the request (with its own KB, system
    prompt, tools, etc.).
6.  Specialist's response is returned to the caller.

**Configuration:**

```yaml
spec:
  coordination: routing
  router:
    agent: triage-agent       # required: which agent classifies
    routes:                    # required: intent-to-agent mapping
      - intent: billing
        agent: billing-agent
      - intent: technical
        agent: tech-support-agent
    fallback: general-agent   # required: default when no intent matches
```

**Required fields for routing:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.router.agent` | string | Agent ref for the router |
| `spec.router.routes` | array | Intent-to-agent mapping entries |
| `spec.router.routes[].intent` | string | Intent label the router produces |
| `spec.router.routes[].agent` | string | Agent ref to handle this intent |
| `spec.router.fallback` | string | Agent ref when no intent matches |

**Optional fields for routing:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.router.model` | string | Override model for the router agent |
| `spec.router.systemPrompt` | string | Override system prompt for the router agent |

------------------------------------------------------------------------

### Handoff (Sequential Pipeline)

Agents process the request in sequence. Each agent's output becomes the
next agent's input. This pattern is suited for multi-stage processing
where each stage transforms or enriches the content.

**Flow:**

1.  Request enters the pipeline at stage 1.
2.  Agent A processes the request, its response becomes input for
    Agent B.
3.  Agent B processes, its response becomes input for Agent C.
4.  The final agent's response is returned to the caller.

**Configuration:**

```yaml
spec:
  coordination: handoff
  pipeline:
    - agent: intake-agent
    - agent: enrichment-agent
    - agent: response-agent
```

**Required fields for handoff:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.pipeline` | array | Ordered list of pipeline stages |
| `spec.pipeline[].agent` | string | Agent ref for this stage |

**Message transformation between stages:** The orchestrator replaces the
last user message content with the previous agent's response. System
messages and conversation history are preserved for each agent's own
configuration.

------------------------------------------------------------------------

### Parallel

All worker agents receive the same input concurrently. A merge agent
combines their outputs into a single response.

**Flow:**

1.  Request is sent to all worker agents simultaneously
    (`Promise.all`).
2.  Each worker processes independently.
3.  Merge agent receives all worker outputs as context in a structured
    format.
4.  Merge agent produces the final response.

**Configuration:**

```yaml
spec:
  coordination: parallel
  workers:
    - agent: research-agent
    - agent: analysis-agent
    - agent: fact-check-agent
  merge:
    agent: synthesis-agent
    systemPrompt: |
      Combine the following research, analysis, and fact-check results
      into a coherent response.
```

**Required fields for parallel:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.workers` | array | List of worker agent refs |
| `spec.workers[].agent` | string | Agent ref for this worker |
| `spec.merge.agent` | string | Agent ref for the merge step |

**Optional fields for parallel:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.merge.systemPrompt` | string | Override system prompt for the merge agent |
| `spec.merge.model` | string | Override model for the merge agent |

**Merge input format:** Worker outputs are injected into the merge
agent's context as labeled sections:

```
--- Output from research-agent ---
{research agent's response}

--- Output from analysis-agent ---
{analysis agent's response}

--- Output from fact-check-agent ---
{fact-check agent's response}
```

------------------------------------------------------------------------

### Supervisor

A coordinator agent dynamically manages workers. The supervisor can
invoke workers multiple times in a loop via tool calls until satisfied
with the result. This is the most flexible pattern, suited for tasks
where the number and order of sub-agent invocations is not known in
advance.

**Flow:**

1.  Supervisor agent receives the request.
2.  Supervisor decides which workers to invoke (via tool calls injected
    by the orchestrator).
3.  Worker results are fed back to the supervisor as tool call results.
4.  Supervisor can invoke more workers or produce its final response.
5.  Loop continues until the supervisor signals completion or
    `maxIterations` is reached.

**Configuration:**

```yaml
spec:
  coordination: supervisor
  supervisor:
    agent: manager-agent
    maxIterations: 5          # safety limit
    workers:
      - agent: worker-a
        description: "Handles data retrieval"
      - agent: worker-b
        description: "Handles analysis"
```

**Required fields for supervisor:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.supervisor.agent` | string | Agent ref for the supervisor |
| `spec.supervisor.workers` | array | Available worker agents |
| `spec.supervisor.workers[].agent` | string | Agent ref for this worker |
| `spec.supervisor.workers[].description` | string | Description exposed to the supervisor as tool description |

**Optional fields for supervisor:**

| Field | Type | Description |
|-------|------|-------------|
| `spec.supervisor.maxIterations` | number | Maximum supervisor loop iterations (default: 10) |
| `spec.supervisor.model` | string | Override model for the supervisor agent |
| `spec.supervisor.systemPrompt` | string | Override system prompt for the supervisor agent |

**Tool injection:** The orchestrator injects one tool definition per
worker into the supervisor's request. Each tool is named
`invoke_{agent-name}` with the worker's description and an input schema
accepting a `message` string. When the supervisor calls one of these
tools, the orchestrator dispatches to the referenced agent and returns
the result as a tool call response.

------------------------------------------------------------------------

## Channels

Channels provide named communication paths between agents within a team.
They are optional and support two patterns:

| Pattern | Description |
|---------|-------------|
| `broadcast` | Messages are delivered to all subscribed agents |
| `directed` | Messages are delivered to a single target agent |

**Configuration:**

```yaml
spec:
  channels:
    - name: customer-intake
      pattern: broadcast
    - name: classified-tickets
      pattern: directed
```

Channels are created during deployment and are scoped to the team. They
are not exposed externally. Channel usage is pattern-dependent (the
orchestrator decides when to write to or read from channels based on the
coordination pattern).

------------------------------------------------------------------------

## Shared Knowledge Bases

`spec.sharedKnowledgeBases` declares KBs available to all member agents
during team execution. When the TeamOrchestrator invokes a sub-agent, it
merges the team's shared KBs with the agent's own `knowledgeBaseRefs`.

```yaml
spec:
  sharedKnowledgeBases:
    - company-policies-kb
    - product-catalog-kb
```

Shared KBs are resolved during weave using the same cross-reference
resolution logic as other artifact references (local workspace first,
registry fallback second).

During execution, RAG retrieval runs once per sub-agent invocation. The
retrieval query is derived from the input to that specific sub-agent,
not the original user request (except for the first agent in the chain).

------------------------------------------------------------------------

## Runtime Architecture

### Directory Structure

```
src/orchestration/
  TeamOrchestrator.ts       # Main entry point, pattern dispatch
  patterns/
    RouterPattern.ts        # Routing coordination logic
    HandoffPattern.ts       # Sequential pipeline logic
    ParallelPattern.ts      # Concurrent execution + merge logic
    SupervisorPattern.ts    # Iterative supervisor loop logic
  TeamContext.ts            # Runtime state for active team execution
```

### Request Flow

In `src/index.ts`, after resolving the tenant context, the request
handler checks whether the resolved entity is an AgentTeam deployment.
If so, it routes to `TeamOrchestrator` instead of the single-agent path.

```
Request → Auth → Resolve Deployment
  ├─ Agent deployment    → applyAgentToRequest → provider.proxy
  └─ AgentTeam deployment → TeamOrchestrator.execute
```

### TeamOrchestrator

```typescript
class TeamOrchestrator {
  constructor(
    private em: EntityManager,
  ) {}

  async execute(
    teamConfig: AgentTeamConfig,
    request: ChatCompletionRequest,
    tenantCtx: TenantContext,
  ): Promise<ChatCompletionResponse> {
    const pattern = this.resolvePattern(teamConfig.coordination);
    const ctx = new TeamContext(teamConfig, tenantCtx);
    return pattern.execute(ctx, request);
  }

  private resolvePattern(coordination: string): CoordinationPattern {
    switch (coordination) {
      case 'routing':    return new RouterPattern();
      case 'handoff':    return new HandoffPattern();
      case 'parallel':   return new ParallelPattern();
      case 'supervisor': return new SupervisorPattern();
      default: throw new Error(`Unknown coordination pattern: ${coordination}`);
    }
  }
}
```

### Sub-Agent Invocation

Sub-agent invocations are direct function calls through the existing
`applyAgentToRequest` + `provider.proxy` pipeline. They do not make
internal HTTP calls. This avoids HTTP overhead and auth complexity for
intra-team calls.

Each sub-agent invocation:

1.  Loads the agent's configuration (system prompt, model, KB refs).
2.  Merges shared KBs from the team config.
3.  Runs RAG retrieval if applicable.
4.  Calls the provider via the existing proxy pipeline.
5.  Records a trace row.

------------------------------------------------------------------------

## Tracing

Each sub-agent invocation produces its own Trace row with:

| Field | Description |
|-------|-------------|
| `requestId` | Unique ID for this sub-agent invocation |
| `parentRequestId` | Links to the team-level trace |
| `teamId` | Identifies the AgentTeam artifact |
| `teamRole` | Role within the team (e.g., `router`, `specialist:billing`, `worker:research-agent`, `supervisor`, `merge`) |

The team-level trace captures:

-   Overall latency (from request receipt to final response)
-   Coordination pattern used
-   Number of sub-agent invocations
-   Member agent count

This structure allows the dashboard to display a tree view of team
executions, showing how the request flowed through the member agents.

------------------------------------------------------------------------

## Workspace Integration

AgentTeam participates in the workspace dependency graph. Teams depend
on their member agents and shared KBs.

### Cross-Reference Fields

| Field | Source Kind | Target Kind |
|-------|-----------|-------------|
| `spec.agents[].ref` | AgentTeam | Agent |
| `spec.router.agent` | AgentTeam | Agent |
| `spec.router.routes[].agent` | AgentTeam | Agent |
| `spec.router.fallback` | AgentTeam | Agent |
| `spec.pipeline[].agent` | AgentTeam | Agent |
| `spec.workers[].agent` | AgentTeam | Agent |
| `spec.merge.agent` | AgentTeam | Agent |
| `spec.supervisor.agent` | AgentTeam | Agent |
| `spec.supervisor.workers[].agent` | AgentTeam | Agent |
| `spec.sharedKnowledgeBases[]` | AgentTeam | KnowledgeBase |

### Dependency Order

Topological order extends the existing workspace ordering:

| Order | Kind | Rationale |
|-------|------|-----------|
| 1 | EmbeddingAgent | No dependencies on other workspace artifacts |
| 2 | ToolPackage | Independent (no cross-references to other kinds) |
| 3 | KnowledgeBase | May depend on EmbeddingAgent via `embedder.agentRef` |
| 4 | Agent | May depend on KnowledgeBase via `knowledgeBaseRef` |
| 5 | AgentTeam | Depends on Agents and KnowledgeBases |

Within a kind tier, artifacts with no intra-tier dependencies are
processed in alphabetical order for deterministic output.

------------------------------------------------------------------------

## CLI Support

AgentTeam uses the unified CLI command set (no separate commands).

### Scaffolding

```bash
arachne init --kind AgentTeam
```

Produces a workspace directory with a template AgentTeam YAML and
placeholder agent specs:

```
my-team/
  team.yaml              # kind: AgentTeam
  agent-a.yaml           # kind: Agent (placeholder)
  agent-b.yaml           # kind: Agent (placeholder)
```

### Weave

```bash
arachne weave ./my-team/
```

Validates member refs (local workspace + registry fallback), resolves
the dependency graph, weaves all artifacts in order, and produces `.orb`
bundles.

### Push and Deploy

```bash
arachne push dist/*.orb --tag 0.1.0
arachne deploy acme/my-team:0.1.0 --tenant acme --env staging
```

Standard artifact lifecycle. No AgentTeam-specific commands.

### Validation (dry-run)

```bash
arachne weave --dry-run ./my-team/
```

Validates:

-   All agent refs resolve (local or registry)
-   All shared KB refs resolve
-   Pattern-specific required fields are present
-   No circular dependencies
-   `spec.agents` list is consistent with pattern-specific agent refs

**Example output:**

```
Workspace: ./my-team/ (5 artifacts)

  Validating specs...
  ✓ Agent/triage-agent — valid
  ✓ Agent/billing-agent — valid
  ✓ Agent/tech-support-agent — valid
  ✓ Agent/general-agent — valid
  ✓ AgentTeam/customer-support-team — valid
    coordination: routing
    router: triage-agent (local workspace)
    routes: billing → billing-agent, technical → tech-support-agent
    fallback: general-agent (local workspace)
    agents: 4 refs resolved

  Dependency order:
    1. Agent/triage-agent
    2. Agent/billing-agent
    3. Agent/tech-support-agent
    4. Agent/general-agent
    5. AgentTeam/customer-support-team

✓ Workspace is valid (5 artifacts, 0 errors)
```

------------------------------------------------------------------------

## Deployment

When an AgentTeam is deployed:

1.  **Validate member agents:** All member agents must already be
    deployed in the target environment (or deployed first in workspace
    mode). If any member agent is missing, the deploy fails with an
    error listing the undeployed agents.
2.  **Create channels:** Any declared channels that do not already exist
    are created and scoped to the team.
3.  **Register subscriptions:** Channel subscriptions are configured for
    member agents based on the coordination pattern.
4.  **Issue runtime token:** A runtime token is provisioned for the team
    endpoint. The team's API key resolves to the AgentTeam deployment,
    which the request handler routes to TeamOrchestrator.

### Deployment Validation Errors

```
Error: Cannot deploy AgentTeam/customer-support-team
  Missing deployments for member agents:
    - billing-agent (not deployed in env: staging)
    - tech-support-agent (not deployed in env: staging)
  Deploy these agents first, or use workspace deploy to deploy all
  artifacts in dependency order.
```

------------------------------------------------------------------------

## ArtifactKind Extension

Add `'AgentTeam'` to the `ArtifactKind` union type. The team's
coordination config is stored in the Artifact entity's `metadata` JSON
field. No new database tables are required for the artifact itself.

```typescript
type ArtifactKind = 'Agent' | 'KnowledgeBase' | 'EmbeddingAgent'
  | 'ToolPackage' | 'AgentTeam';
```

The Artifact entity stores:

| Artifact Field | AgentTeam Usage |
|---------------|-----------------|
| `kind` | `'AgentTeam'` |
| `metadata` | Full coordination config (pattern, agent refs, channels, etc.) |
| `spec` | Raw YAML spec content (for display and re-weaving) |

------------------------------------------------------------------------

## Security Considerations

-   **Internal invocations:** Sub-agent invocations within a team are
    direct function calls. No external API key is needed for intra-team
    calls.
-   **Tenant isolation:** The team's tenant context is inherited by all
    member agents. Member agents must belong to the same tenant as the
    team.
-   **Encryption:** Sub-agent traces are encrypted with the same
    per-tenant derived key as regular agent traces.
-   **No privilege escalation:** A team cannot grant its member agents
    capabilities beyond what they would have as standalone deployments.
-   **Supervisor safety:** The `maxIterations` limit prevents runaway
    loops. When exceeded, the orchestrator returns the supervisor's last
    response with a warning header.

------------------------------------------------------------------------

## Validation Rules

### Weave-Time Validation

-   `spec.coordination` is one of the four supported patterns.
-   All agent refs in `spec.agents` resolve (local workspace or
    registry).
-   All pattern-specific agent refs (router, pipeline, workers, merge,
    supervisor) are present in `spec.agents`.
-   All shared KB refs resolve.
-   Pattern-specific required fields are present (e.g., `router.routes`
    for routing, `pipeline` for handoff).
-   `spec.agents` contains no duplicate refs.
-   No self-references (an agent cannot appear as both supervisor and
    worker with the same ref).

### Deploy-Time Validation

-   All member agents are deployed in the target environment.
-   All shared KBs are deployed in the target environment.
-   Member agents belong to the same tenant as the team.

------------------------------------------------------------------------

## Limitations

-   **No nested teams:** A team cannot reference another team as a
    member. The `spec.agents` list may only contain Agent refs, not
    AgentTeam refs.
-   **Same-tenant only:** All member agents must belong to the same
    tenant as the team.
-   **Synchronous execution:** Sub-agent invocations are synchronous
    within the request lifecycle. There is no background or async
    execution.
-   **No streaming for multi-step patterns:** Intermediate sub-agent
    responses in handoff, parallel, and supervisor patterns are not
    streamed to the caller. Only the final response supports streaming.
-   **Supervisor iteration cap:** The supervisor pattern enforces a
    `maxIterations` limit (default: 10) to prevent infinite loops.

------------------------------------------------------------------------

## Full Workspace Example

### Directory Layout

```
customer-support/
  triage-agent.yaml
  billing-agent.yaml
  tech-support-agent.yaml
  general-agent.yaml
  support-team.yaml
  docs/
    company-policies.md
    billing-faq.md
```

### triage-agent.yaml

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: triage-agent
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    You are a triage agent. Classify the user's request into one of:
    billing, technical, general. Respond with only the category name.
```

### billing-agent.yaml

```yaml
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: billing-agent
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    You are a billing specialist. Help customers with invoices,
    payments, and subscription changes.
  knowledgeBaseRef: company-policies-kb
```

### support-team.yaml

```yaml
apiVersion: arachne-ai.com/v0
kind: AgentTeam
metadata:
  name: customer-support-team
spec:
  coordination: routing

  router:
    agent: triage-agent
    routes:
      - intent: billing
        agent: billing-agent
      - intent: technical
        agent: tech-support-agent
      - intent: general
        agent: general-agent
    fallback: general-agent

  agents:
    - ref: triage-agent
    - ref: billing-agent
    - ref: tech-support-agent
    - ref: general-agent

  sharedKnowledgeBases:
    - company-policies-kb
```

### CLI Workflow

```bash
# Validate the workspace
arachne weave --dry-run ./customer-support/

# Weave all artifacts
arachne weave ./customer-support/

# Push all bundles
arachne push dist/*.orb --tag 0.1.0

# Deploy in dependency order
arachne deploy acme/triage-agent:0.1.0 --tenant acme --env staging
arachne deploy acme/billing-agent:0.1.0 --tenant acme --env staging
arachne deploy acme/tech-support-agent:0.1.0 --tenant acme --env staging
arachne deploy acme/general-agent:0.1.0 --tenant acme --env staging
arachne deploy acme/customer-support-team:0.1.0 --tenant acme --env staging
```

------------------------------------------------------------------------

## Future Extensions

These features are out of scope for MVP but inform the design decisions
above.

### Nested Teams (Team of Teams)

Allow an AgentTeam to reference other AgentTeams as members. This
introduces a recursive coordination model where a supervisor team could
delegate to specialist sub-teams.

### Cross-Tenant Agent References (Marketplace)

Enable teams to reference agents published by other tenants in a shared
marketplace. Requires a trust and billing model for cross-tenant
invocations.

### Async Execution with Callback

Support long-running team executions that return immediately with a job
ID and deliver results via webhook callback. Useful for supervisor
patterns with many iterations.

### Custom Coordination Patterns via Plugin System

Allow tenants to define custom coordination patterns beyond the four
built-in ones. Patterns would be packaged as ToolPackages with a
specific handler interface.

### Agent-Level Retry and Fallback

Configure per-agent retry policies and fallback agents within a team.
If a specialist agent fails, the orchestrator can retry or route to an
alternative agent.

### Streaming for Intermediate Steps

Stream intermediate sub-agent responses to the caller via SSE, allowing
UIs to show progress as the team processes a request through multiple
stages.

------------------------------------------------------------------------

## Summary

The AgentTeam artifact kind provides declarative multi-agent
orchestration within Arachne. By supporting four coordination patterns
(routing, handoff, parallel, supervisor) as YAML configuration rather
than code, teams can be versioned, validated, and deployed through the
same pipeline as all other Arachne artifacts. The design preserves full
traceability through linked trace rows and maintains tenant isolation
through inherited security contexts.
