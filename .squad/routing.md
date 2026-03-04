# Routing Rules

| Signal | Agent | Why |
|--------|-------|-----|
| Architecture, design decisions, code review | Keaton | Lead owns high-level decisions and review gates |
| Gateway, proxy, streaming, API endpoints, trace recording | Fenster | Backend owns server-side implementation |
| Dashboard, UI, React components, visualization | McManus | Frontend owns client-side implementation |
| Tests, validation, quality checks, edge cases | Hockney | Tester owns quality assurance |
| PRD decomposition, work breakdown | Keaton | Lead decomposes requirements into work items |
| Multi-tenant architecture, database schema | Fenster | Backend owns data layer |
| Observability, metrics display | McManus | Frontend owns visualization layer |
| Integration testing, streaming validation | Hockney | Tester validates end-to-end flows |
| Analytics pipelines, aggregation, time-series queries | Redfoot | Data Engineer owns analytics layer above raw trace storage |
| Token/cost/latency analytics, per-tenant usage metrics | Redfoot | Data Engineer aggregates observability signal |
| Dashboard data contracts, analytics data shapes | Redfoot | Data Engineer defines what McManus visualizes |
| Observability metrics definition, granularity strategy | Redfoot | Data Engineer owns what gets measured and how |
| Domain modeling, entity definitions, aggregate boundaries | Verbal | Domain Expert owns the domain model |
| Color Modeling archetypes (Moment-Interval, Role, Catalog-Entry, Party/Place/Thing) | Verbal | Domain Expert applies Peter Coad's methodology |
| Value objects vs entities, domain events, ubiquitous language | Verbal | Domain Expert defines domain vocabulary and invariants |
| AI provider integration, OpenAI/Anthropic/Azure adapters | Kobayashi | AI Expert owns provider-side implementation |
| Prompt engineering, system messages, context strategies | Kobayashi | AI Expert owns LLM input design |
| Model routing, cost/latency/capability tradeoffs | Kobayashi | AI Expert owns model selection logic |
| Token budgeting, context window management, truncation | Kobayashi | AI Expert owns token lifecycle |
| LLM observability, trace enrichment, token counts, cost estimates | Kobayashi | AI Expert owns AI-specific telemetry |
| Streaming chunk handling, SSE, partial trace recording | Kobayashi | AI Expert owns LLM streaming behavior |
| Embeddings, multi-modal, evals, A/B model testing | Kobayashi | AI Expert owns advanced AI capabilities |
| Documentation, README, user guides, CLI docs | Edie | Technical Writer owns all docs |
| Internal architecture docs, API reference | Edie | Technical Writer maintains internal documentation |
| Public-facing feature docs, announcements, tutorials | Edie | Technical Writer owns user-facing content |
| Documentation review, Definition of Done doc gate | Edie | Technical Writer reviews stories for doc completeness |
| Cloud infrastructure, Terraform, Azure resources | Kujan | DevOps Engineer owns all infrastructure as code |
| CI/CD pipelines, GitHub Actions workflows | Kujan | DevOps Engineer owns build/deploy automation |
| Docker image builds, container registry, GHCR | Kujan | DevOps Engineer owns containerization and publishing |
| Deployment automation, environment config, secrets management | Kujan | DevOps Engineer owns release pipeline |
| Azure Container Apps, Static Web Apps, PostgreSQL Flexible Server | Kujan | DevOps Engineer owns Azure resource provisioning |
