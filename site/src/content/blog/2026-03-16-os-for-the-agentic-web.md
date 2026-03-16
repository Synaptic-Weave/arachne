---
title: "Arachne: The Operating System for the Agentic Web"
date: 2026-03-16
author: Michael Brown
description: "Every agent built today is a small miracle of integration work. Memory, retrieval, security, observability: these are the system calls of the agentic web. They belong in a runtime, not in application code."
tags:
  - architecture
  - agents
  - open-source
  - vision
---

Every agent built today is a small miracle of integration work.

Before your agent can do anything useful (answer a question, complete a task, remember who it's talking to) someone has to wire together a half-dozen systems that have nothing to do with the agent's actual purpose. Memory. Retrieval. Security. Networking. Storage. Observability. Each one is a project in itself. Each one is table stakes.

This is what building software looked like before operating systems.

## The Pre-OS Era of AI Agents

In the 1960s, every program managed its own memory. It talked directly to hardware. It implemented its own file I/O. Developers spent more time on infrastructure than on the problem they were trying to solve. Then operating systems emerged: not as products, but as a recognition that certain capabilities are so fundamental that every application needs them, and no application should have to build them.

We are in the same moment for AI agents.

Build an agent today and you will spend the majority of your time on everything *except* the agent's intelligence:

**Memory.** Your agent needs to remember conversations. That means a persistence layer, token counting, context window management, and a summarization strategy for when history exceeds the window. You'll implement this, debug it, and discover that your approach doesn't generalize when you build your second agent.

**Recall and retrieval.** Your agent needs access to knowledge. That means an embedding pipeline, a vector database, chunking strategies, retrieval scoring, and injection logic to get the right context into the prompt at the right time. Get any of these wrong and your agent hallucinates confidently from irrelevant context.

**Security.** Your agent handles user data. That means encryption at rest, per-tenant key derivation, API key management, authentication, authorization, and audit logging. Skip any of these and you've built a liability, not a product.

**Network access.** Your agent calls LLM providers. That means HTTP client management, streaming support, error handling, retry logic, and provider-specific request/response format translation. Switch providers and you rewrite your networking layer.

**Storage.** Your agent produces traces, logs, analytics. That means a database schema, batch write strategies, partitioning for scale, and query patterns for debugging. This is pure infrastructure: zero differentiation.

And that's the *minimum*. We haven't mentioned observability (what did my agent actually do?), evaluations (is it getting better or worse?), CI/CD (how do I deploy changes safely?), cost management (how much is this costing me?), or multi-tenancy (how do I serve multiple customers from one system?).

Every team building agents today is solving the same problems independently. Badly, because these aren't their core competency, and incompletely, because there isn't time to do all of them well.

## What Operating Systems Actually Do

An operating system is not one thing. It's a collection of capabilities that are:

1. **Universal**: every application needs them
2. **Undifferentiated**: no application gains competitive advantage by implementing them differently
3. **Foundational**: getting them wrong undermines everything built on top
4. **Composable**: they combine in ways that individual implementations cannot

Memory management. File systems. Networking. Process scheduling. Security and permissions. Device drivers. The OS provides these as primitives so that application developers can focus on what makes their software valuable.

The same pattern applies to AI agents. Memory, retrieval, security, provider networking, storage, observability: these are the system calls of the agentic web. They are universal, undifferentiated, foundational, and composable. They belong in a runtime, not in application code.

## Arachne as Runtime

Arachne is an AI runtime. Not a framework. Not a library. A runtime: the layer between your agent's intelligence and the infrastructure it needs to function.

When your agent runs on Arachne, it doesn't implement memory. It declares `conversations_enabled: true` and gets persistent, token-aware, automatically-summarized conversation memory. It doesn't build a RAG pipeline. It references a knowledge base and gets vector retrieval with context injection. It doesn't manage API keys or encrypt data. Arachne derives per-tenant encryption keys and encrypts everything at rest (traces, conversations, provider credentials) by default, not as an add-on.

Here's what Arachne handles so your agent doesn't have to:

| Capability | Without Arachne | With Arachne |
|------------|----------------|--------------|
| **Conversation memory** | Build persistence, token counting, summarization, context injection | `conversations_enabled: true` |
| **Knowledge retrieval** | Embedding pipeline, vector DB, chunking, scoring, injection | `knowledgeBaseRef: "my-kb"` |
| **Provider access** | HTTP clients, streaming, format translation, error mapping per provider | Provider-agnostic proxy: swap providers by changing config |
| **Security** | Encryption, key management, auth, tenant isolation | AES-256-GCM with per-tenant keys, built in from day one |
| **Observability** | Logging, tracing, analytics, dashboards | Every request traced automatically, analytics built in |
| **Multi-tenancy** | Per-customer data isolation, config inheritance, user management | Native multi-tenant architecture with subtenant hierarchies |
| **Agent lifecycle** | Ad-hoc deployment, no versioning, no rollback | Define, version, deploy, evaluate, iterate |

This is the operating system pattern. Your agent is the application. Arachne is the kernel.

## The Compounding Effect

Individual capabilities are useful. The combination is transformative.

Because Arachne manages both conversation memory *and* tracing, you can debug a multi-turn conversation by replaying the exact context your agent saw at each turn. Because it manages both provider routing *and* cost tracking, you can see exactly what each conversation costs and route future requests to cheaper models when quality permits. Because it manages both RAG retrieval *and* observability, you can measure retrieval quality across thousands of requests and tune your chunking strategy with data, not intuition.

These cross-cutting insights are impossible when each capability is a separate system wired together with glue code. They emerge naturally when the capabilities share a runtime.

## What Becomes Possible

When you stop building infrastructure, you start building agents.

**Agent evaluations.** Define test suites for your agents. Run them on every change. Track quality metrics over time. Catch regressions before your users do. This is only practical when the runtime already captures every interaction (you don't need to instrument anything).

**Intelligent model routing.** Not every request needs your most expensive model. A classification task can run on a smaller, faster, cheaper model. Arachne can route requests based on complexity, cost constraints, and latency requirements: reducing costs by 40-60% without quality degradation. This is only possible when the runtime understands both the request and the provider landscape.

**Agent teams.** Multiple agents coordinating on complex tasks, sharing context through a coordinator pattern. Memory, security, and observability apply uniformly across the team, because the runtime provides them, not the agents.

**Portable agents.** Arachne's open spec means agent definitions are not locked to the runtime. Define your agent once, deploy it anywhere that implements the spec. This is the POSIX moment for AI agents: a standard interface that decouples the application from the platform.

## Why Open

We built Arachne as open source with an open specification for a reason that is strategic, not ideological.

Operating systems won by being the layer that everyone builds on. Layers that everyone builds on cannot be proprietary black boxes (the risk is too high). Teams adopt platforms they can trust, and trust requires the ability to leave.

Agents built for Arachne are portable. The spec is open. The code is open. If Arachne stops being the best runtime, you take your agents and go. We believe this makes adoption faster, not slower, because it eliminates the single biggest objection enterprises have to platform adoption: lock-in.

We compete on runtime quality, not captive audiences.

## The Agentic Web Needs an OS

The number of AI agents in production is about to grow by orders of magnitude. Most of them will be built by teams whose expertise is in their domain (healthcare, finance, legal, education, customer service) not in distributed systems, encryption, or retrieval pipelines.

These teams deserve a runtime that handles the infrastructure so they can focus on the intelligence. They deserve memory that works, retrieval that's accurate, security that's default, and observability that's automatic. They deserve to swap providers without rewriting code, deploy changes without fear, and understand costs without spreadsheets.

They deserve an operating system for the agentic web.

That's what we're building.

---

*Arachne is in private beta. If you're building AI agents and want a runtime that handles the infrastructure, [get in touch](https://arachne-ai.com).*
