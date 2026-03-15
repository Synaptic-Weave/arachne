---
title: CLI Quickstart
description: Using the Arachne CLI to weave and deploy agents
order: 3
---


The Arachne CLI lets you define agents as code, version them, and deploy them to any Arachne instance. Think of it as `docker build` and `docker push` for AI agents.

## Install

Install the CLI globally via npm:

```bash
npm install -g @arachne/cli
```

Verify the installation:

```bash
arachne --version
```

## Login

Authenticate with your Arachne instance:

```bash
arachne login --instance https://api.arachne-ai.com
```

This opens a browser-based OAuth flow and stores your credentials locally.

## Write an Agent Spec

Create a file called `agent.yaml` in your project directory:

```yaml
kind: Agent
name: docs-assistant
version: 1.0.0

model: gpt-4o
provider: openai

system_prompt: |
  You are a technical documentation assistant for Acme Corp.
  Answer questions using only the provided knowledge base.
  If you don't know the answer, say so honestly.

conversations:
  enabled: true
  token_limit: 8000

knowledge_base:
  ref: acme-docs-kb
  top_k: 5

skills:
  - name: code-review
    prompt: |
      When reviewing code, provide specific line-level feedback
      and suggest improvements with examples.
    merge_policy: append
```

The spec captures everything about an agent: model, behavior, memory settings, knowledge base references, and skills.

## Weave

Weave bundles your agent spec and any referenced assets into a deployable artifact:

```bash
arachne weave agent.yaml
```

This validates the spec, resolves references, and produces a local artifact. If you reference a knowledge base, weave will bundle the source documents for embedding at deploy time.

```
Weaving agent.yaml...
  Validated agent spec: docs-assistant@1.0.0
  Resolved knowledge base: acme-docs-kb (3 documents)
  Artifact: docs-assistant-1.0.0.arachne

Done.
```

## Push

Push the artifact to your Arachne instance's registry:

```bash
arachne push docs-assistant-1.0.0.arachne
```

The registry stores versioned artifacts with content-addressable storage. You can push multiple versions and roll back at any time.

```
Pushing docs-assistant-1.0.0.arachne...
  Registry: https://api.arachne-ai.com/v1/registry
  Artifact: docs-assistant@1.0.0
  Size: 24.3 KB

Pushed successfully.
```

## Deploy

Deploy the artifact to make it live:

```bash
arachne deploy docs-assistant@1.0.0
```

This creates or updates the agent on the target instance, processes any bundled knowledge base documents, and makes the agent available for API key binding.

```
Deploying docs-assistant@1.0.0...
  Agent created: docs-assistant
  Knowledge base: acme-docs-kb (3 documents, 127 chunks)
  Embeddings generated: 127/127

Deployed successfully.
```

## Full Workflow

Here is the typical development cycle:

```bash
# Edit your agent spec
vim agent.yaml

# Bundle it
arachne weave agent.yaml

# Push to registry
arachne push docs-assistant-1.0.0.arachne

# Deploy to your instance
arachne deploy docs-assistant@1.0.0
```

You can also combine weave, push, and deploy in a single command:

```bash
arachne weave agent.yaml --push --deploy
```

## CI/CD Integration

Add Arachne to your deployment pipeline:

```yaml
# .github/workflows/deploy-agent.yml
name: Deploy Agent
on:
  push:
    branches: [main]
    paths: [agent.yaml]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @arachne/cli
      - run: arachne login --token ${{ secrets.ARACHNE_TOKEN }}
      - run: arachne weave agent.yaml --push --deploy
```

## Next Steps

- [Agent Spec Reference](/developers/api-reference) — Full schema for `agent.yaml`.
- [Portal Guide](/docs/portal-guide) — Manage deployed agents in the UI.
- [Architecture](/developers/architecture) — Understand how agents are resolved at runtime.
