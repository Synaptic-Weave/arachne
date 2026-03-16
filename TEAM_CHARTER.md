# Arachne Team Charter

*Drafted by Neo, Morpheus, and Agent Smith — 2026-03-15*
*Approved by: [Product Owner]*

---

## Part I: Vision, Mission, and Product Context
*Author: Neo — Product Vision Interpreter*

### 1. Team Mission Statement

We exist to build Arachne — the open, provider-agnostic AI runtime that lets any organization deploy, observe, and govern AI agents at scale without being locked into a single vendor. We serve developers who define agents, tenant admins who manage them, platform operators who keep things running, and end users who interact with them. Our job is to make portable, secure, observable AI infrastructure feel as natural as deploying a web application.

### 2. Product Vision

**North Star:** Any AI agent, defined once, runs anywhere — across providers, across tenants, across versions.

Arachne is headed toward becoming the standard runtime and open specification for portable AI agents and knowledge bases. Today we are a multi-tenant gateway with conversation memory, RAG inference, and a CLI-driven artifact lifecycle (`weave`, `push`, `deploy`). Where we are going:

- **Open spec adoption.** The `arachne-ai.com/v0` artifact format should be implementable by any runtime, not just ours. Agent portability is the moat — not our infrastructure.
- **Multi-provider, multi-model fluency.** Tenants choose their providers (OpenAI, Azure, Ollama, and more to come). The gateway abstracts away the differences so agent definitions never mention a vendor.
- **Developer experience as differentiator.** The CLI, the `@arachne/chat` embeddable component, the Portal self-service UI, and the SDK should form a cohesive toolchain where each surface is the best way to accomplish its task.
- **Observability as a first-class citizen.** Every request produces a trace. Every RAG retrieval records diagnostic fields. Every conversation is encrypted at rest. Operators should never wonder what happened — they should be able to see it.
- **Enterprise-grade multi-tenancy.** Subtenant hierarchies with inherited configuration, per-tenant encryption keys, partitioned trace storage, and granular access controls.

### 3. Users and Personas

| Persona | Description | Primary Surface |
|---------|-------------|-----------------|
| **Tenant Admins** | Manage agents, API keys, conversation settings, invite team members, review analytics. Care about security, cost visibility, and control. | Portal |
| **Agent Developers** | Define agents/KBs as YAML specs, weave into artifacts via CLI, push to registry, deploy. Want a git-friendly, reproducible workflow. | CLI |
| **Platform Operators** | Monitor health and performance, manage tenants, review traces, track token spend. Care about the 20ms overhead target and multi-version safety. | Dashboard |
| **End Users** | Interact with agents via the gateway API or `@arachne/chat`. Don't know or care about Arachne — they experience an agent that works. | Gateway API |

### 4. Product Principles

When two principles conflict, the lower-numbered one takes precedence.

1. **Provider-agnostic above all.** Never lock tenants into a single LLM vendor. If a feature requires a specific provider, it must be behind an adapter.
2. **Encrypt everything at rest.** Security is non-negotiable. Trace bodies, conversation messages, snapshots, and provider API keys — all encrypted with per-tenant derived keys.
3. **Gateway overhead below 20ms.** Speed is a feature. Auth is LRU-cached. Traces are fire-and-forget. No per-chunk DB writes during streaming.
4. **Portable agent definitions.** Agents and KBs are declarative YAML specs with a versioned API. Artifacts are content-addressable and immutable once pushed.
5. **Observability by default.** Every request produces a trace. Every RAG retrieval records diagnostics. If something happens, it should be visible without enabling a flag.
6. **Graceful degradation over hard failure.** RAG failures fall back to no-RAG. Provider errors are mapped to a consistent format. The system always attempts to serve the user.

### 5. Vertical Slice Philosophy

Every story delivers a vertical slice — a thin but complete path through the full stack that results in something a user can see, touch, or use when the story ships.

**Litmus test:** "If this story shipped to production today and nothing else shipped for two weeks, would a user notice something new?" If the answer is no, the slice is not vertical enough.

### 6. Multi-Version Reality

Three independently versioned artifacts may coexist in production:

| Artifact | Package | Consumers |
|----------|---------|-----------|
| Gateway | `arachne` | All tenants, all API consumers |
| CLI | `@arachne/cli` | Agent developers |
| Chat SDK | `@arachne/chat` | End-user-facing applications |

This is why we use gitflow. Release branches allow us to patch older versions. The `develop` branch is our integration point. Hotfix branches allow emergency patches without destabilizing develop.

**Implications:**
- API versioning is not optional (`/v1/`, `apiVersion: arachne-ai.com/v0` are contracts)
- Backwards compatibility is the default
- Breaking changes require a version bump
- Changesets track what changed and for whom

---

## Part II: Process and Methodology
*Author: Morpheus — Scrum Master*

### 7. Lean Principles

#### Lead Time as the North Star Metric

We do not measure velocity (points per sprint). We measure **lead time**: elapsed time from the moment a backlog item is accepted into active work until the change is live on production.

Lead time is decomposed into four segments:

| Segment | Starts | Ends | Owner |
|---------|--------|------|-------|
| Queue time | Item accepted from backlog | First agent begins work | Morpheus |
| Development time | First commit on feature branch | PR opened against `develop` | Tank, Switch, Oracle |
| Review time | PR opened | PR approved and merged to `develop` | Smith, Niobe, Cipher |
| Release time | Change lands on `develop` | Change live on `main` / production | Product Owner |

#### WIP Limits

- **Stories in active development: 1** (the swarm target)
- **Stories in review: 2** maximum
- **Stories in release: 3** maximum — if hit, pause development and cut a release
- **Isolation branches per story:** merge back within 24 hours

#### Metrics We Track

| Metric | Target |
|--------|--------|
| Lead time (acceptance to production) | Under 5 business days |
| Queue time | Under 4 hours |
| Review cycle time | Under 24 hours per round |
| Blocked percentage | Under 10% of lead time |
| Release frequency | At least weekly |
| Escaped defects | Zero regressions per release |

### 8. Swarming Model

#### What Swarming Means

The entire team converges on a single story. All 12 agents contribute to finishing one story as fast as possible. This is the default operating mode.

#### How Agents Coordinate

1. **Requirements phase:** Neo refines the story. Morpheus confirms readiness.
2. **Architecture phase:** Architect produces domain model, decomposes into tasks, defines API contracts.
3. **Implementation phase (the swarm):** Agents work on isolation branches off the feature branch. Tank (backend) and Switch (frontend) work in parallel once the API contract is defined. Mouse begins test scaffolding from interface contracts.
4. **Testing phase:** Mouse completes test suite. Overlaps with implementation.
5. **Security review:** Niobe and Cipher review (parallel with each other).
6. **Code review:** Smith reviews for quality and pattern adherence.
7. **Impact assessment:** Merovingian evaluates operational impact.

#### Unfeasibility Triggers (When to Pick Up a Second Story)

- **Review gate:** Story is in review and all implementation is complete. Idle agents pull the next item.
- **External dependency block:** Blocked on something outside the team's control.
- **Diminishing returns:** More than 3 agents are idle because remaining work is serial.
- **Hotfix interrupt:** A minimal subset peels off for the hotfix; the rest continue swarming.

### 9. Story Format

#### Vertical Slices

Every story must be a vertical slice — a thin but complete cut that delivers user-visible value and can be deployed independently.

**Properties of a good story:**
1. **User-facing** — written from the perspective of someone who uses the system
2. **Deployable** — can go to production without waiting for other stories
3. **Testable** — acceptance criteria specific enough for Mouse to write tests
4. **Cross-cutting** — naturally spans multiple layers

#### Good Story Examples

> **As a tenant admin**, I want to configure conversation memory token limits for my agents through the portal so I can control token costs.

Layers: DB migration → backend service → API route → Portal UI → tests

> **As an operator**, I want to see provider health status on the dashboard so I can detect upstream issues before tenants report them.

Layers: analytics query → dashboard route → Dashboard UI → tests

#### Anti-Examples (Tasks Disguised as Stories)

| Bad "Story" | Why It Fails |
|-------------|--------------|
| "Add a `max_tokens` column to the agents table" | Single-layer. No user value. |
| "Refactor PortalService to use MikroORM" | Internal. No user-visible change. |
| "Write unit tests for the encryption module" | Tests are part of DoD, not standalone stories. |

#### Story Template

```
Title: [Short imperative phrase, under 70 characters]

As a [tenant admin | API consumer | operator | platform admin],
I want to [specific capability]
so that [business outcome / reason].

Acceptance Criteria:
- [ ] [Observable behavior 1]
- [ ] [Observable behavior 2]
- [ ] [Edge case / error handling]

Layers Affected:
- [ ] Database migration
- [ ] Backend service
- [ ] API route
- [ ] Portal UI / Dashboard UI / CLI
- [ ] Tests (unit, integration, smoke)
```

### 10. Gitflow Branching Strategy

#### Branch Types and Naming

All branches: `[type]/[issue-number]-short-title`

| Type | Purpose | Branches From | Merges To |
|------|---------|---------------|-----------|
| `feature/` | New feature | `develop` | `develop` |
| `bugfix/` | Bug fix | `develop` | `develop` |
| `hotfix/` | Critical production fix | `main` | `main` and `develop` |
| `release/` | Release stabilization | `develop` | `main` and `develop` |

#### Isolation Branches

```
develop
  └── feature/42-conversation-memory-limits         (work-item branch)
        ├── feature/42-conversation-memory-limits/tank-backend
        ├── feature/42-conversation-memory-limits/switch-portal-ui
        └── feature/42-conversation-memory-limits/mouse-tests
```

Isolation branches merge back to the work-item branch (not to `develop`). Short-lived — merge at least daily.

#### Rules

1. Feature branches from `develop`, merge back via PR. Never merge directly to `main`.
2. Release branches: once cut, **no new features merge from `develop`**. Only fixes, which merge back to `develop`.
3. **Only the Product Owner merges `release/*` into `main`.** Hard rule.
4. Hotfix branches from `main`, merge to both `main` (with PO approval) and `develop`.
5. No direct commits to `develop` or `main`. All changes through branches and PRs.

---

## Part III: Quality Standards and Engineering Practices
*Author: Agent Smith — Code Review and Quality Enforcement*

### 11. Code Review Gates

No code merges without satisfying every gate. No exceptions.

#### Smith's Review Checklist (Every PR)

| Category | What Is Verified |
|----------|------------------|
| TypeScript Conventions | `strict: true` not weakened. No `any` without justification. ESM `.js` extensions. |
| Persistence Strategy | Correct layer used (MikroORM for domain services, Knex for legacy/analytics). No mixing. |
| Tenant Isolation | Every query filters by `tenant_id`. Data path traced from route to database. |
| Gateway Hot Path | No blocking operations. Auth hits LRU cache. Traces fire-and-forget. |
| Pattern Consistency | Providers extend `BaseProvider`. Routes are thin. Entities use `EntitySchema`. |
| Error Handling | Gateway errors follow OpenAI format. Internal errors caught and logged, never leaked. |

#### Security Sign-off (Niobe + Cipher)

Required when changes touch: auth middleware, encryption, JWT handling, API key operations, provider key storage, new unauthenticated routes, or security-relevant DB migrations.

#### Impact Assessment (Merovingian)

Required for high-risk changes: gateway hot path, DB schema, provider interface, encryption pipeline, tenant resolution chain, new dependencies.

### 12. Engineering Standards (Non-Negotiable)

These are invariants. Violating any is a blocking review finding.

1. **TypeScript strict mode** — `"strict": true` stays. No weakening.
2. **Tenant data isolation** — every query filters by `tenant_id`.
3. **Persistence strategy correctness** — domain services use MikroORM, legacy/analytics use Knex. No mixing.
4. **Gateway hot path** — no blocking operations, 20ms overhead budget.
5. **Encryption at rest** — all tenant content encrypted via AES-256-GCM with per-tenant key derivation.
6. **Parameterized queries only** — `$1, $2` placeholders. No string interpolation in SQL. Ever.
7. **ESM module convention** — `.js` extensions in all internal imports.

### 13. Testing Requirements

| Scope | When Required | Pattern |
|-------|---------------|---------|
| Unit tests | All new business logic | Mock `EntityManager` or `src/db.ts` |
| Route tests | All new API endpoints | Mock services, test HTTP contract |
| Frontend tests | New Portal/Dashboard components | React Testing Library + userEvent |
| Integration tests | Entity/schema changes | `DB_DRIVER=sqlite`, full CRUD lifecycle |
| Security tests | Security-sensitive changes | Derived from Cipher's attack stories |
| Smoke tests | UI changes | Playwright (`npm run test:smoke`) |

### 14. Commit and Branch Hygiene

- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- **Branch naming:** `[type]/[issue-number]-short-title`
- **Atomic commits:** one logical change per commit
- **No secrets in commits.** If a secret is accidentally committed: rotate immediately, force-push to remove, notify Niobe.

### 15. Swarming Quality Protocol

- **Continuous review** — Smith reviews every commit as it lands, not at end-of-story
- **Integration gates** at: schema ready, service layer complete, route layer complete, security review, frontend integration, smoke test pass
- **File ownership** assigned by Architect at swarm start to minimize merge conflicts
- **One migration per story** — no competing migrations from multiple agents
- **Shared interfaces first** — Tank and Switch agree on DTOs before implementing independently

### 16. Definition of Done

A story is done when every item is checked:

- [ ] All acceptance criteria met
- [ ] `npm run build` succeeds (zero errors, zero warnings)
- [ ] `npm test` passes (backend + portal)
- [ ] `npm run test:smoke` passes (if UI changes)
- [ ] Code reviewed by Agent Smith — all findings resolved
- [ ] Security reviewed by Niobe/Cipher (if security-sensitive)
- [ ] Impact assessed by Merovingian (if high-risk)
- [ ] Test coverage maintained or increased
- [ ] TypeScript strict mode passes
- [ ] Every new query filters by `tenant_id`
- [ ] New tenant data encrypted at rest
- [ ] Parameterized queries only
- [ ] Conventional commits, branch naming correct
- [ ] Documentation updated (CLAUDE.md if architecture changes, API docs if endpoints change)
- [ ] No secrets committed
- [ ] Changeset created (if user-facing change)
- [ ] PR merged to `develop` — no direct pushes

---

## Signatures

| Role | Agent | Acknowledged |
|------|-------|-------------|
| Product Vision | Neo | 2026-03-15 |
| Scrum Master | Morpheus | 2026-03-15 |
| UX Architect | Trinity | 2026-03-15 |
| Frontend Engineer | Switch | 2026-03-15 |
| Backend Engineer | Tank | 2026-03-15 |
| Domain Modeling | Architect | 2026-03-15 |
| Test Engineer | Mouse | 2026-03-15 |
| AI Systems | Oracle | 2026-03-15 |
| Security Engineer | Niobe | 2026-03-15 |
| Pentester | Cipher | 2026-03-15 |
| Code Review | Agent Smith | 2026-03-15 |
| System Impact | Merovingian | 2026-03-15 |
| **Product Owner** | **Michael (Chief Architect)** | **2026-03-15** |
